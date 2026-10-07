const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('node:readline/promises');
const puppeteer = require('puppeteer');
const handler = require('serve-handler');
const sharp = require('sharp');
const GIFEncoder = require('gif-encoder-2');

// ---------- CONFIG ----------
const CONFIG = {
  campaignDir: process.cwd(),
  outputFolderName: '_BACKUPS',
  adSelector: '#ad',
  // gifStep_1, gifStep_2_5 (= 5s delay), gifStep_3_1.5 (= 1.5s delay)...
  labelPattern: /^gifStep_(\d+)(?:_(\d+(?:\.\d+)?))?$/,
  frameDelay: 3,
  loopCount: 3,
  quality: 10,
  keepFrames: false,
  viewport: { width: 2000, height: 2000 },
  excludeFolders: ['_BACKUPS', 'node_modules', '.git'],
};

const outputDir = path.join(CONFIG.campaignDir, CONFIG.outputFolderName);

// ---------- UTILS ----------
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) on: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function startServer(folder) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, { public: folder }));
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function askLoopCount(defaultValue) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `🔁 Number of loops for the GIFs (0 = infinite, Enter = default ${defaultValue}): `
  );
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === '') return defaultValue;

  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.log(`  ⚠ Invalid value, using default (${defaultValue}).`);
    return defaultValue;
  }
  return parsed;
}

// Finds, inside the headless browser context, whichever GSAP timeline
// (anywhere in the gsap.globalTimeline tree) contains gifStep_X labels.
async function getGifSteps(page, pattern) {
  const patternSource = pattern.source;
  return page.evaluate((patternSource) => {
    const regex = new RegExp(patternSource);

    function findTimelineWithLabels(root, visited = new Set()) {
      if (visited.has(root)) return null;
      visited.add(root);
      if (root.labels) {
        const hasSteps = Object.keys(root.labels).some((name) => regex.test(name));
        if (hasSteps) return root;
      }
      if (typeof root.getChildren === 'function') {
        const children = root.getChildren(false, false, true);
        for (const child of children) {
          const found = findTimelineWithLabels(child, visited);
          if (found) return found;
        }
      }
      return null;
    }

    const tl = findTimelineWithLabels(gsap.globalTimeline);
    if (!tl) return null;

    window.__gifTL = tl;

    const labels = Object.entries(tl.labels)
      .map(([name, time]) => {
        const match = name.match(regex);
        if (!match) return null;
        return {
          name,
          time,
          step: parseInt(match[1], 10),
          customDelay: match[2] ? parseFloat(match[2]) : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.step - b.step);

    return { labels };
  }, patternSource);
}

async function makeGif(frames, outputPath, loopCount) {
  const firstMeta = await sharp(frames[0].path).metadata();
  const width = firstMeta.width;
  const height = firstMeta.height;

  const encoder = new GIFEncoder(width, height, 'neuquant', true);
  const stream = fs.createWriteStream(outputPath);
  encoder.createReadStream().pipe(stream);

  encoder.start();
  // GIF89a "repeat" field = repetitions AFTER the first playthrough.
  // 0 is reserved for "infinite loop" and must not be shifted.
  encoder.setRepeat(loopCount === 0 ? 0 : loopCount - 1);
  encoder.setQuality(CONFIG.quality);
  encoder.setTransparent(false);

  for (const frame of frames) {
    encoder.setDelay(frame.delaySec * 1000);
    const { data } = await sharp(frame.path)
      .resize(width, height)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    encoder.addFrame(data);
  }

  encoder.finish();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ---------- CORE ----------
async function processBanner(browser, bannerDir, bannerName, loopCount) {
  console.log(`\n▶ ${bannerName}`);

  const { server, port } = await startServer(bannerDir);
  const page = await browser.newPage();
  await page.setViewport(CONFIG.viewport);

  page.on('dialog', async (dialog) => {
    console.log(`  ⚠ Dialog detected and dismissed: "${dialog.message()}"`);
    await dialog.dismiss();
  });

  // Patch gsap.timeline() to always start paused, inside the headless browser
  // context only — the banner's source file on disk is never modified.
  // Without this, the timeline may already have played past your target
  // frame by the time the script is ready to seek into it.
  await page.evaluateOnNewDocument(() => {
    let _gsap;
    Object.defineProperty(window, 'gsap', {
      configurable: true,
      get() { return _gsap; },
      set(value) {
        if (value && typeof value.timeline === 'function' && !value.__patchedForCapture) {
          const originalTimeline = value.timeline.bind(value);
          value.timeline = function (vars = {}) {
            vars = { ...vars, paused: true };
            return originalTimeline(vars);
          };
          value.__patchedForCapture = true;
        }
        _gsap = value;
      },
    });
  });

  try {
    await withTimeout(
      page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle0' }),
      10000, 'goto'
    );
    await withTimeout(page.evaluateHandle(() => document.fonts.ready), 5000, 'fonts.ready');

    let hasLabels = false;
    try {
      await page.waitForFunction(
        (patternSource) => {
          if (typeof gsap === 'undefined' || !gsap.globalTimeline) return false;
          const regex = new RegExp(patternSource);
          function search(root, visited = new Set()) {
            if (visited.has(root)) return false;
            visited.add(root);
            if (root.labels && Object.keys(root.labels).some((n) => regex.test(n))) return true;
            if (typeof root.getChildren === 'function') {
              return root.getChildren(false, false, true).some((c) => search(c, visited));
            }
            return false;
          }
          return search(gsap.globalTimeline);
        },
        { timeout: 4000 },
        CONFIG.labelPattern.source
      );
      hasLabels = true;
    } catch {
      hasLabels = false;
    }

    if (!hasLabels) {
      console.warn(`  ⚠ No "gifStep_X" label found on ${bannerName}, skipped.`);
      return;
    }

    const result = await withTimeout(getGifSteps(page, CONFIG.labelPattern), 5000, 'getGifSteps');
    if (!result || !result.labels || result.labels.length === 0) {
      console.warn(`  ⚠ No "gifStep_X" label found on ${bannerName}, skipped.`);
      return;
    }

    const steps = result.labels;
    console.log(`  → ${steps.length} step(s) detected: ${steps.map((s) =>
      `${s.name}${s.customDelay ? ` (${s.customDelay}s)` : ''}`
    ).join(', ')}`);

    const tmpDir = path.join(os.tmpdir(), 'gif-backup-maker', bannerName);
    fs.mkdirSync(tmpDir, { recursive: true });

    const adHandle = await page.$(CONFIG.adSelector);
    if (!adHandle) throw new Error(`Selector "${CONFIG.adSelector}" not found`);

    const frames = [];
    for (const step of steps) {
      // IMPORTANT: wrap seek() in a block so page.evaluate() returns `undefined`.
      // Returning the timeline instance (which seek() does, for chaining) forces
      // Puppeteer to serialize a huge object graph across the CDP boundary,
      // which can hang for a very long time.
      await withTimeout(
        page.evaluate((t) => { window.__gifTL.seek(t, true); }, step.time),
        10000, `seek ${step.name}`
      );

      await new Promise((r) => setTimeout(r, 150));

      const framePath = path.join(tmpDir, `frame_${step.step}.png`);
      await withTimeout(adHandle.screenshot({ path: framePath }), 5000, `screenshot ${step.name}`);

      const delaySec = step.customDelay ?? CONFIG.frameDelay;
      frames.push({ path: framePath, delaySec });
      console.log(`  ✓ ${step.name} captured (delay: ${delaySec}s)`);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const gifPath = path.join(outputDir, `${bannerName}.gif`);
    await makeGif(frames, gifPath, loopCount);
    console.log(`  🎞  GIF generated → ${gifPath}`);

    if (!CONFIG.keepFrames) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`  ✗ Error on ${bannerName}: ${err.message}`);
  } finally {
    await page.close();
    server.close();
  }
}

// ---------- RUN ----------
(async () => {
  const banners = fs.readdirSync(CONFIG.campaignDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !CONFIG.excludeFolders.includes(name) && !name.startsWith('.'))
    .filter((name) => fs.existsSync(path.join(CONFIG.campaignDir, name, 'index.html')));

  console.log(`📁 Folder: ${CONFIG.campaignDir}`);
  console.log(`${banners.length} banner(s) detected.`);

  if (banners.length === 0) {
    console.log('Nothing to do — run this from inside a folder containing banner subfolders (each with an index.html).');
    return;
  }

  const loopCount = await askLoopCount(CONFIG.loopCount);
  console.log(`  → loops: ${loopCount === 0 ? 'infinite' : loopCount}`);

  console.log('🚀 Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 60000,
  });

  for (const name of banners) {
    await processBanner(browser, path.join(CONFIG.campaignDir, name), name, loopCount);
  }

  const tmpRoot = path.join(os.tmpdir(), 'gif-backup-maker');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  await browser.close();
  console.log(`\n✅ Done. Results in: ${outputDir}`);
})();
