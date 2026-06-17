import { execSync } from 'child_process';

function cmdExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

console.log('[cfryze] Verificando dependencias del sistema...');

if (!cmdExists('google-chrome-stable') && !cmdExists('google-chrome')) {
  console.log('[cfryze] Google Chrome no encontrado. Instalando...');
  try {
    execSync('wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O chrome.deb', { stdio: 'inherit' });
    execSync('sudo apt install -y ./chrome.deb || apt install -y ./chrome.deb', { stdio: 'inherit' });
    execSync('rm chrome.deb', { stdio: 'ignore' });
    console.log('[cfryze] ✅ Google Chrome instalado.');
  } catch (e) {
    console.error('[cfryze] ❌ No se pudo instalar Chrome automáticamente. Instálalo manualmente.');
  }
} else {
  console.log('[cfryze] ✅ Google Chrome ya está instalado.');
}

if (!cmdExists('Xvfb')) {
  console.log('[cfryze] Xvfb no encontrado. Instalando...');
  try {
    execSync('sudo apt install -y xvfb || apt install -y xvfb', { stdio: 'inherit' });
    console.log('[cfryze] ✅ Xvfb instalado.');
  } catch (e) {
    console.error('[cfryze] ❌ No se pudo instalar Xvfb. Instálalo manualmente (sudo apt install xvfb).');
  }
} else {
  console.log('[cfryze] ✅ Xvfb ya está instalado.');
}