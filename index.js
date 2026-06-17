import { ScraperPool } from './lib/scraper-pool.js';

export { ScraperPool };

export async function createSolver(opts = {}) {
  const pool = new ScraperPool(opts);
  await pool.init();
  return pool;
}

export default ScraperPool;
