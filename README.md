# HTML Banner Backup Maker

Automatically generate animated GIF backups from GSAP-powered HTML5 banner ads — no manual screenshotting, no Photoshop frame-by-frame assembly.

## The problem this solves

If you produce HTML5 display banners, you probably still need a static GIF "backup" version for ad networks that don't support rich media. The usual process is painfully manual:

1. Open the banner locally, open DevTools
2. Pause the animation at each key step
3. Right-click → "Capture node screenshot" → save PNG
4. Repeat for every step, for every single banner format
5. Open all PNGs in Photoshop, stack them, build a frame animation, set delays/loops, export

For a campaign with 20+ formats, that's hours of repetitive manual work.

## What this tool does instead

Point it at a folder containing all your banner formats. It will, for each one:

1. Launch a headless browser and load the banner locally
2. Find the GSAP timeline containing your `gifStep_X` labels
3. Jump (`seek`) directly to each labeled step — no need to watch the animation play in real time
4. Screenshot the ad container at each step
5. Assemble all steps into a single animated GIF
6. Save everything into a `_BACKUPS` folder, automatically created next to your banner folders

Run once, get all your GIF backups for the entire campaign.

## Requirements

- [Node.js](https://nodejs.org) (LTS version recommended)
- Your banner must use [GSAP](https://gsap.com/) with a timeline

## Installation

```bash
git clone https://github.com/yourusername/html-banner-backup-maker.git
cd html-banner-backup-maker
npm install

## Convention: labeling your GSAP timeline

The only thing required in your banner's code is to add labels to your main GSAP timeline, following this naming pattern:

```js
const tl = gsap.timeline();

tl.to('.logo', { opacity: 1, duration: 1 })
  .addLabel('gifStep_1', '>')
  .to('.headline', { x: 0, duration: 1 })
  .addLabel('gifStep_2', '>')
  .to('.cta', { scale: 1, duration: 0.5 })
  .addLabel('gifStep_3', '>');
```

**No need to expose your timeline on `window`** — the script automatically walks the entire GSAP timeline tree (via `gsap.globalTimeline`) to find whichever timeline contains your `gifStep_X` labels, no matter what variable name you used.

### Custom delay per step (optional)

By default, every frame in the final GIF uses the delay configured in `CONFIG.frameDelay` (3 seconds). To override the delay for a specific step, append the duration (in seconds) to the label name:

```js
.addLabel('gifStep_1')        // uses default delay
.addLabel('gifStep_2_5')      // 5 seconds for this step
.addLabel('gifStep_3_1.5')    // 1.5 seconds for this step
```

## Usage

1. Organize your campaign folder with each banner format in its own subfolder, each containing an `index.html`:

```
my-campaign/
  banner-300x250/index.html
  banner-728x90/index.html
  banner-160x600/index.html
```

2. From inside that folder, run:

```bash
node /path/to/html-banner-backup-maker/generate-backups.js
```

3. You'll be prompted for the number of loops:

```
🔁 Number of loops for the GIFs (0 = infinite, Enter = default 3):
```

4. Result:

```
my-campaign/
  _BACKUPS/
    banner-300x250.gif
    banner-728x90.gif
    banner-160x600.gif
  banner-300x250/
  banner-728x90/
  banner-160x600/
```

Banners without `gifStep_X` labels are automatically skipped (with a warning), so you can run this on a campaign folder even if only some formats have been updated yet.

## Configuration

All settings live at the top of `generate-backups.js`:

```js
const CONFIG = {
  outputFolderName: '_BACKUPS',
  adSelector: '#ad',          // CSS selector of your main ad container
  labelPattern: /^gifStep_(\d+)(?:_(\d+(?:\.\d+)?))?$/,
  frameDelay: 3,               // default seconds per frame
  loopCount: 3,                // default, overridden by the prompt
  quality: 10,                  // GIF encoder quality (1 = best/slowest, 30 = fastest/lower quality)
  viewport: { width: 2000, height: 2000 },
  excludeFolders: ['_BACKUPS', 'node_modules', '.git'],
};
```

## Technical notes (a few traps worth knowing)

- **GSAP timelines autoplay by default.** The script patches `gsap.timeline()` (only inside the headless browser context, your banner's source code is never touched) to force every timeline to start paused — otherwise, by the time the script is ready to seek, your animation may have already played past the point you wanted to capture.
- **`.seek()` returns the timeline instance itself** (for chaining). Returning that from `page.evaluate()` makes Puppeteer try to serialize a huge, complex object across the browser/Node boundary — which can hang for a very long time. Always wrap it in a block so nothing is returned: `page.evaluate((t) => { tl.seek(t, true); }, time)`.
- **GIF loop count is off by one.** The GIF89a spec's "repeat" field means "repetitions *after* the first playthrough", not "total plays". Requesting 2 loops from the user means passing `1` to the encoder (`0` stays reserved for infinite).

## License

MIT — do whatever you want with it.

## Credits

Built through an iterative pair-programming session with an AI assistant (Claude), going from "is this even automatable?" to a working batch tool across several rounds of real debugging on an actual production campaign.
