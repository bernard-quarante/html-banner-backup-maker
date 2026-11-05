const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const readline = require('node:readline/promises');
const puppeteer = require('puppeteer');
const handler = require('serve-handler');
const sharp = require('sharp');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const CONFIG = {
  campaignDir: process.cwd(),
  outputFolderName: '_BACKUPS',
  adSelector: '#ad',
  labelPattern: /^gifStep_(\d+)(?:_(\d+(?:\.\d+)?))?$/,
  frameDelay: 3,
  loopCount: 3,
  keepFrames: false,
  viewport: { width: 2000, height: 2000 },
  excludeFolders: ['_BACKUPS', 'node_modules', '.git'],
  maxDepth: 6,
};

function findBannerFolders(rootDir, depth = 0) {
  const results = [];
  if (depth > CONFIG.maxDepth) return results;

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (CONFIG.excludeFolders.includes(entry.name)) continue;

    const fullPath = path.join(rootDir, entry.name);

    if (fs.existsSync(path.join(fullPath, 'index.html'))) {
      results.push({ bannerDir: fullPath, bannerName: entry.name, groupDir: rootDir });
    } else {
      results.push(...findBannerFolders(fullPath, depth + 1));
    }
  }

  return results;
}

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
  const answer = await rl.question(`🔁 Number of loops (0 = infinite, Enter = default ${defaultValue}): `);
  rl.close();
  const trimmed = answer.trim();
  if (trimmed === '') return defaultValue;
  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

async function getGifSteps(page, pattern) {
  const patternSource = pattern.source;
  return page.evaluate((patternSource) => {
    const regex = new RegExp(patternSource);
    function findTimelineWithLabels(root, visited = new Set()) {
      if (visited.has(root)) return null;
      visited.add(root);
      if (root.labels) {
        if (Object.keys(root.labels).some((name) => regex.test(name))) return root;
      }
      if (typeof root.getChildren === 'function') {
        for (const child of root.getChildren(false, false, true)) {
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
        return { name, time, step: parseInt(match[1], 10), customDelay: match[2] ? parseFloat(match[2]) : null };
      })
      .filter(Boolean)
      .sort((a, b) => a.step - b.step);
    return { labels };
  }, patternSource);
}

async function makeGif(frames, finalOutputPath, loopCount) {
  const firstMeta = await sharp(frames[0].path).metadata();
  const width = firstMeta.width;
  const height = firstMeta.height;

  const gif = GIFEncoder();
  const repeat = loopCount === 0 ? 0 : loopCount - 1;

  for (const frame of frames) {
    const { data } = await sharp(frame.path)
      .resize(width, height)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);

    gif.writeFrame(index, width, height, {
      palette,
      delay: frame.delaySec * 1000,
      repeat,
    });
  }

  gif.finish();

  const tmpGifPath = path.join(os.tmpdir(), 'gif-backup-maker', `${Date.now()}-${path.basename(finalOutputPath)}`);
  fs.mkdirSync(path.dirname(tmpGifPath), { recursive: true });
  fs.writeFileSync(tmpGifPath, gif.bytes());

  fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });
  fs.copyFileSync(tmpGifPath, finalOutputPath);
  fs.rmSync(tmpGifPath, { force: true });
}

async function processBanner(browser, bannerDir, bannerName, loopCount, outputDir, label) {
  console.log(`\n▶ ${label}`);

  const { server, port } = await startServer(bannerDir);
  const page = await browser.newPage();
  await page.setViewport(CONFIG.viewport);

  page.on('dialog', async (dialog) => {
    console.log(`  ⚠ Dialog dismissed: "${dialog.message()}"`);
    await dialog.dismiss();
  });

  await page.evaluateOnNewDocument(() => {
    let _gsap;
    Object.defineProperty(window, 'gsap', {
      configurable: true,
      get() { return _gsap; },
      set(value) {
        if (value && typeof value.timeline === 'function' && !value.__patchedForCapture) {
          const originalTimeline = value.timeline.bind(value);
          value.timeline = function (vars = {}) {
            return originalTimeline({ ...vars, paused: true });
          };
          value.__patchedForCapture = true;
        }
        _gsap = value;
      },
    });
  });

  try {
    await withTimeout(page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle0' }), 10000, 'goto');
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
      console.warn(`  ⚠ No "gifStep_X" label found, skipped.`);
      return;
    }

    const result = await withTimeout(getGifSteps(page, CONFIG.labelPattern), 5000, 'getGifSteps');
    if (!result?.labels?.length) {
      console.warn(`  ⚠ No "gifStep_X" label found, skipped.`);
      return;
    }

    const steps = result.labels;
    console.log(`  → ${steps.length} step(s): ${steps.map((s) => s.name).join(', ')}`);

    const tmpDir = path.join(os.tmpdir(), 'gif-backup-maker', bannerName + '-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    const adHandle = await page.$(CONFIG.adSelector);
    if (!adHandle) throw new Error(`Selector "${CONFIG.adSelector}" not found`);

    const frames = [];
    for (const step of steps) {
      await withTimeout(page.evaluate((t) => { window.__gifTL.seek(t, true); }, step.time), 10000, `seek ${step.name}`);
      await new Promise((r) => setTimeout(r, 150));

      const framePath = path.join(tmpDir, `frame_${step.step}.png`);
      await withTimeout(adHandle.screenshot({ path: framePath }), 5000, `screenshot ${step.name}`);

      frames.push({ path: framePath, delaySec: step.customDelay ?? CONFIG.frameDelay });
      console.log(`  ✓ ${step.name} captured`);
    }

    const gifPath = path.join(outputDir, `${bannerName}.gif`);
    await makeGif(frames, gifPath, loopCount);
    console.log(`  🎞  GIF generated → ${gifPath}`);

    if (!CONFIG.keepFrames) fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`  ✗ Error on ${label}: ${err.message}`);
  } finally {
    await page.close();
    server.close();
  }
}

(async () => {
  const bannerFolders = findBannerFolders(CONFIG.campaignDir);

  console.log(`📁 Root: ${CONFIG.campaignDir}`);
  console.log(`${bannerFolders.length} banner(s) detected.`);

  if (bannerFolders.length === 0) {
    console.log('Nothing to do — no folder containing index.html was found.');
    return;
  }

  const groups = new Set(bannerFolders.map((b) => b.groupDir));
  console.log(`${groups.size} group(s) → one _BACKUPS folder will be created per group.`);

  const loopCount = await askLoopCount(CONFIG.loopCount);
  console.log(`  → loops: ${loopCount === 0 ? 'infinite' : loopCount}`);
  console.log('🚀 Launching browser...');

  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 60000 });

  for (const { bannerDir, bannerName, groupDir } of bannerFolders) {
    const outputDir = path.join(groupDir, CONFIG.outputFolderName);
    const label = path.relative(CONFIG.campaignDir, bannerDir) || bannerName;
    await processBanner(browser, bannerDir, bannerName, loopCount, outputDir, label);
  }

  const tmpRoot = path.join(os.tmpdir(), 'gif-backup-maker');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });

  await browser.close();
  console.log(`\n✅ Done.`);
})();