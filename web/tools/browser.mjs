// browser.mjs — one place that knows how to get a Chromium.
//
// This environment ships a pre-installed Chromium under PLAYWRIGHT_BROWSERS_PATH, but the
// npm playwright package pins an exact build number and refuses to launch anything else.
// An `npm install` that bumps playwright therefore breaks every screenshot tool at once
// with "please run npx playwright install" — and installing is not the fix, because the
// browser is already there and downloading another is wasteful.
//
// So: try the normal launch, and on failure fall back to the browser the environment
// actually provides. Every tool goes through here rather than calling chromium.launch
// directly, so this only ever has to be solved once.
import { chromium } from 'playwright';
import { existsSync } from 'fs';

const FALLBACKS = [
  '/opt/pw-browsers/chromium',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
];

const ARGS = ['--enable-unsafe-swiftshader'];

export async function launchChromium(opts = {}) {
  const args = [...ARGS, ...(opts.args || [])];
  try {
    return await chromium.launch({ ...opts, args });
  } catch (err) {
    const path = FALLBACKS.find(existsSync);
    if (!path) throw err;
    return await chromium.launch({ ...opts, args, executablePath: path });
  }
}
