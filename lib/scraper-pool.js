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
    this.#headless = opts.headless ?? false;

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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
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
      width: 1280 + Math.floor(Math.random() * 200),
      height: 720 + Math.floor(Math.random() * 100),
    });
    
    await page.setExtraHTTPHeaders({
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      'dnt': '1',
    });

    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url().toLowerCase();

        if (url.includes('cloudflare') || url.includes('turnstile') || url.includes('challenges')) {
          req.continue();
          return;
        }

        if (type === 'document' || type === 'script' || type === 'xhr' || type === 'fetch') {
          const adDomains = [
            'googlesyndication', 'doubleclick', 'google-analytics', 'googletagmanager',
            'facebook.com', 'fbcdn', 'dnstatic', 'adservice', 'adsense',
            's8ey.com', 'iclick', 'propellerads', 'popcash', 'popads', 'popunder',
            'exoclick', 'juicyads', 'trafficjunky', 'clickadu', 'hilltopads',
            'adsterra', 'monetag', 'a-ads', 'coinzilla', 'bidvertiser',
            'outbrain', 'taboola', 'mgid', 'revcontent', 'content.ad',
            'hotjar', 'clarity.ms', 'mixpanel', 'segment.io', 'amplitude',
            'sentry.io', 'bugsnag', 'newrelic', 'datadog',
            'intercom', 'drift', 'crisp', 'zendesk', 'freshdesk',
          ];
          
          if (adDomains.some(d => url.includes(d))) {
            req.abort();
          } else {
            req.continue();
          }
        } else {
          req.abort();
        }
      });
    } catch {}

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
    console.log(`[ryzea-turnstile] ✅ Pool listo (max ${this.#maxWindows} ventanas)`);
    return this;
  }

  async warmup(count) {
    const toCreate = Math.min(count ?? this.#maxWindows, this.#maxWindows);
    console.log(`[ryzea-turnstile] Abriendo ${toCreate} ventanas...`);
    
    for (let i = 0; i < toCreate; i++) {
      try {
        const win = await this.#createWindow();
        this.#windowPool.push(win);
      } catch (err) {
        console.error(`[ryzea-turnstile] ventana ${i + 1} falló: ${err.message}`);
      }
    }
    
    console.log(`[ryzea-turnstile] ✅ ${this.#windowPool.length} ventanas abiertas`);
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

  async solveTurnstile(url, sitekey) {
    const startTime = Date.now();
    let win = null;
    const waitStart = Date.now();

    while (!win) {
      win = await this.#getAvailableWindow();
      if (!win) {
        if (Date.now() - waitStart > 60000) {
          return { 
            status: 'failed', 
            creator: 'Ryzea', 
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
          
          try {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
              const type = req.resourceType();
              const u = req.url().toLowerCase();
              
              if (u.includes('cloudflare') || u.includes('turnstile') || u.includes('challenges')) { 
                req.continue(); 
                return; 
              }
              
              if (type === 'document' || type === 'script' || type === 'xhr' || type === 'fetch') { 
                req.continue(); 
              } else { 
                req.abort(); 
              }
            });
          } catch {}
        }
      }

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(1500);

      const hasNativeWidget = await page.evaluate(() => {
        return !!(document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
                  document.querySelector('.cf-turnstile[data-sitekey]'));
      });

      if (!hasNativeWidget) {
        await page.evaluate((key) => {
          let container = document.createElement('div');
          container.className = 'cf-turnstile';
          container.id = 'injected-turnstile';
          container.dataset.sitekey = key;
          container.dataset.action = 'managed';
          container.dataset.appearance = 'always';
          
          Object.assign(container.style, {
            position: 'fixed', 
            top: '50px', 
            left: '50px', 
            zIndex: '99999',
            background: 'white', 
            padding: '10px'
          });
          
          document.body.insertBefore(container, document.body.firstChild);

          window.__turnstileToken = null;
          window.__turnstileError = null;

          const renderWidget = () => {
            if (window.turnstile) {
              try {
                window.turnstile.render(container, {
                  sitekey: key,
                  action: 'managed',
                  callback: (token) => { window.__turnstileToken = token; },
                  'error-callback': (error) => { window.__turnstileError = String(error); },
                  'expired-callback': () => {
                    window.__turnstileToken = null;
                    if (window.turnstile) window.turnstile.reset();
                  }
                });
              } catch (e) { 
                window.__turnstileError = e.message; 
              }
            }
          };

          if (window.turnstile) {
            renderWidget();
          } else {
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
            script.async = true;
            window.onTurnstileLoad = renderWidget;
            document.head.appendChild(script);
          }
        }, sitekey);
      }

      await delay(2000);

      try {
        await page.mouse.move(100 + Math.random() * 200, 100 + Math.random() * 100);
        await delay(150);
        await page.mouse.move(200 + Math.random() * 100, 200 + Math.random() * 100);
      } catch {}

      await delay(2000);

      const pollStart = Date.now();
      let clicks = 0;
      let token = null;

      while (Date.now() - pollStart < 60000) {
        try {
          token = await page.evaluate(() => {
            if (window.__turnstileToken?.length > 20) return window.__turnstileToken;
            const el = document.querySelector('[name="cf-turnstile-response"]');
            if (el?.value?.length > 20) return el.value;
            const byId = document.getElementById('cf-turnstile-response');
            if (byId?.value?.length > 20) return byId.value;
            const ta = document.querySelector('.cf-turnstile textarea, .cf-turnstile input[type="hidden"]');
            if (ta?.value?.length > 20) return ta.value;
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
        return { status: 'active', creator: 'Ryzea', token, time: `${elapsed}ms` };
      }

      this.#stats.failed++;
      return { status: 'failed', creator: 'Ryzea', token: null, error: 'Timeout solving turnstile', time: `${elapsed}ms` };

    } catch (err) {
      this.#stats.total++;
      this.#stats.failed++;
      return { status: 'failed', creator: 'Ryzea', token: null, error: err.message, time: `${Date.now() - startTime}ms` };
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