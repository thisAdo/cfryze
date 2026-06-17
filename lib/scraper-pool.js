import { connect } from 'puppeteer-real-browser';
import UserAgent from 'user-agents';
import { v4 as uuid } from 'uuid';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ScraperPool {
  #maxWindows;
  #retries;
  #headless;
  #proxies = [];
  #proxyIndex = 0;
  #windowPool = [];
  #busyWindows = new Map();
  #stats = { total: 0, success: 0, failed: 0, avgTime: 0 };

  constructor(opts = {}) {
    this.#maxWindows = opts.maxTabs || opts.maxWindows || 5;
    this.#retries = opts.retries ?? 2;
    this.#headless = opts.headless ?? true; 

    if (opts.proxies?.length) {
      this.#proxies = opts.proxies;
    } else if (opts.brightdata) {
      const bd = opts.brightdata;
      const host = bd.host || 'brd.superproxy.io';
      const port = bd.port || 33335;
      const user = bd.username || bd.user;
      const pass = bd.password || bd.pass;
      const sessions = bd.sessions || this.#maxWindows;
      
      this.#proxies = Array.from({ length: sessions }, (_, i) => ({
        host,
        port,
        username: `${user}-session-${Date.now()}_${i}`,
        password: pass,
      }));
    }
  }

  #nextProxy() {
    if (!this.#proxies.length) return null;
    const proxy = this.#proxies[this.#proxyIndex % this.#proxies.length];
    this.#proxyIndex++;
    return proxy;
  }

  async #createWindow() {
    const proxy = this.#nextProxy();
    const connectOpts = {
      headless: this.#headless,
      turnstile: true,
      fingerprint: true,
      disableXvfb: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720'
      ],
    };

    if (proxy) {
      if (typeof proxy === 'object' && proxy.host) {
        connectOpts.proxy = {
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
        };
      } else {
        connectOpts.proxy = { server: proxy };
      }
    }

    const { browser, page } = await connect(connectOpts);

    const ua = new UserAgent({ deviceCategory: 'desktop' }).toString();
    await page.setUserAgent(ua);
    await page.setViewport({
      width: 1280,
      height: 720,
    });
    
    await page.setExtraHTTPHeaders({
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      'dnt': '1',
    });

    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const newPage = await target.page();
          if (newPage && newPage !== page) await newPage.close();
        } catch {}
      }
    });

    const winId = `win_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    return { id: winId, browser, page, createdAt: Date.now(), usageCount: 0 };
  }

  async init() {
    console.log(`Pool listo (max ${this.#maxWindows} ventanas)`);
    return this;
  }

  async warmup(count) {
    const toCreate = Math.min(count ?? this.#maxWindows, this.#maxWindows);
    console.log(`Abriendo ${toCreate} ventanas...`);
    
    for (let i = 0; i < toCreate; i++) {
      try {
        const win = await this.#createWindow();
        this.#windowPool.push(win);
      } catch (err) {
        console.error(`ventana ${i + 1} falló: ${err.message}`);
      }
    }
    
    console.log(`${this.#windowPool.length} ventanas abiertas`);
    return this.#windowPool.length;
  }

  async #getAvailableWindow() {
    if (this.#windowPool.length > 0) return this.#windowPool.shift();
    if (this.#busyWindows.size < this.#maxWindows) return await this.#createWindow();
    return null;
  }

  async #releaseWindow(win) {
    win.usageCount++;
    this.#busyWindows.delete(win.id);
    
    try {
      await win.page.evaluate(() => true);
      this.#windowPool.push(win);
    } catch {
      try { 
        await win.browser.close(); 
      } catch {}
    }
  }

  async solveTurnstile(url, sitekey = null) {
    const startTime = Date.now();
    let win = null;
    const waitStart = Date.now();

    while (!win) {
      win = await this.#getAvailableWindow();
      if (!win) {
        if (Date.now() - waitStart > 60000) {
          return { 
            status: 'failed', 
            creator: 'RyZe', 
            token: null, 
            error: 'Timeout waiting for window', 
            time: `${Date.now() - startTime}ms` 
          };
        }
        await delay(500);
      }
    }

    this.#busyWindows.set(win.id, win);
    let page = win.page;

    try {
      if (win.usageCount > 0) {
        try {
          await page.goto('about:blank', { waitUntil: 'load', timeout: 5000 });
        } catch {
          page = await win.browser.newPage();
          win.page = page;
        }
      }

      await page.setRequestInterception(true);

      if (sitekey) {
        const fakeHtml = `<!DOCTYPE html><html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" async defer></script></head><body><div id="cf-turnstile"></div><script>window.onloadTurnstileCallback=function(){turnstile.render('#cf-turnstile',{sitekey:'${sitekey}',callback:function(t){var i=document.createElement('input');i.type='hidden';i.name='cf-response';i.value=t;document.body.appendChild(i);}});};</script></body></html>`;
        
        page.on('request', async (req) => {
          if (req.url().startsWith(url) && req.resourceType() === 'document') {
            await req.respond({ status: 200, contentType: 'text/html', body: fakeHtml });
          } else if (req.url().includes('challenges.cloudflare.com') || req.url().includes('turnstile')) {
            await req.continue().catch(() => {});
          } else {
            await req.abort().catch(() => {});
          }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } else {
        page.on('request', (req) => {
          const type = req.resourceType();
          const u = req.url().toLowerCase();
          
          if (u.includes('cloudflare') || u.includes('turnstile') || u.includes('challenges')) { 
            req.continue().catch(() => {}); 
            return; 
          }
          
          if (type === 'document' || type === 'script' || type === 'xhr' || type === 'fetch') { 
            req.continue().catch(() => {}); 
          } else { 
            req.abort().catch(() => {}); 
          }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(1500);
      }

      await delay(2000);

      try {
        await page.mouse.move(100 + Math.random() * 200, 100 + Math.random() * 100);
        await delay(150);
        await page.mouse.move(200 + Math.random() * 100, 200 + Math.random() * 100);
      } catch {}

      const pollStart = Date.now();
      let clicks = 0;
      let token = null;

      while (Date.now() - pollStart < 60000) {
        try {
          token = await page.evaluate(() => {
            const native = document.querySelector('[name="cf-turnstile-response"]')?.value;
            if (native?.length > 20) return native;
            
            const injected = document.querySelector('[name="cf-response"]')?.value;
            if (injected?.length > 20) return injected;

            if (window.turnstile?.getResponse()?.length > 20) {
              return window.turnstile.getResponse();
            }
            return null;
          });

          if (token) break;

          if (clicks < 5) {
            try {
              const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]');
              if (iframe) {
                const box = await iframe.boundingBox();
                if (box?.width > 0) {
                  const tx = box.x + 28 + (Math.random() * 4 - 2);
                  const ty = box.y + 28 + (Math.random() * 4 - 2);
                  await page.mouse.move(tx, ty, { steps: 10 });
                  await page.mouse.click(tx, ty, { delay: 50 });
                  clicks++;
                  await delay(2500);
                }
              }
            } catch {}
          }

          await delay(Date.now() - pollStart < 10000 ? 500 : 1000);
        } catch {
          await delay(1000);
        }
      }

      this.#stats.total++;
      const elapsed = Date.now() - startTime;

      if (token) {
        this.#stats.success++;
        this.#stats.avgTime = (this.#stats.avgTime * (this.#stats.total - 1) + elapsed) / this.#stats.total;
        return { status: 'active', creator: 'RyZe', token, time: `${elapsed}ms` };
      }

      this.#stats.failed++;
      return { status: 'failed', creator: 'RyZe', token: null, error: 'Timeout solving turnstile', time: `${elapsed}ms` };

    } catch (err) {
      this.#stats.total++;
      this.#stats.failed++;
      return { status: 'failed', creator: 'RyZe', token: null, error: err.message, time: `${Date.now() - startTime}ms` };
    } finally {
      await this.#releaseWindow(win);
    }
  }

  async solveMany(url, sitekey, count = 5) {
    const needed = Math.min(count, this.#maxWindows);
    const toCreate = Math.max(0, needed - this.#windowPool.length);
    
    if (toCreate > 0) {
      const creates = [];
      for (let i = 0; i < toCreate; i++) {
        creates.push(this.#createWindow().then(w => this.#windowPool.push(w)).catch(() => {}));
      }
      await Promise.all(creates);
    }

    const promises = Array.from({ length: count }, () => this.solveTurnstile(url, sitekey));
    return Promise.all(promises);
  }

  async close() {
    for (const win of this.#windowPool) {
      try { 
        await win.browser.close(); 
      } catch {}
    }
    this.#windowPool = [];
    
    for (const [, win] of this.#busyWindows) {
      try { 
        await win.browser.close(); 
      } catch {}
    }
    this.#busyWindows.clear();
  }

  get stats() {
    return {
      ...this.#stats,
      poolSize: this.#windowPool.length,
      busyWindows: this.#busyWindows.size,
      maxWindows: this.#maxWindows,
    };
  }

  get concurrency() { 
    return this.#maxWindows; 
  }
}

export default ScraperPool;