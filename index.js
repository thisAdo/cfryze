import { execSync } from 'child_process';

if (!process.env.CHROME_PATH) {
  try {
    const chromePath = execSync('which google-chrome-stable || which google-chrome').toString().trim();
    if (chromePath) {
      process.env.CHROME_PATH = chromePath;
    }
  } catch {}
}

import { ScraperPool } from './lib/scraper-pool.js';

export { ScraperPool };

export async function createSolver(opts = {}) {
  const pool = new ScraperPool(opts);
  await pool.init();
  return pool;
}

export default ScraperPool;