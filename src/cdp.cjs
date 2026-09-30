const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function browserCandidates(platform = process.platform, env = process.env) {
  const explicit = [env.BROWSER_PATH, env.EDGE_PATH].filter(Boolean);
  if (platform === 'win32') return [
    ...explicit,
    ...[env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
      .filter(Boolean).map(base => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...[env.ProgramFiles, env.LOCALAPPDATA]
      .filter(Boolean).map(base => path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  ];
  return [...explicit, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
}

function browserPath(platform = process.platform, env = process.env) {
  const found = browserCandidates(platform, env).find(file => fs.existsSync(file));
  if (!found) throw new Error('找不到 Chrome 或 Edge。请安装浏览器，或将 BROWSER_PATH 设为浏览器可执行文件的完整路径');
  return found;
}

function profilePath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'KuaishouDraftBrowser');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'KuaishouDraftBrowser');
}

function launchBrowser(port = 9222) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('无效 CDP 端口');
  const executable = browserPath();
  const profile = profilePath();
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    'https://login.kwaixiaodian.com/'
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return { browser: executable, port, profile, pid: child.pid };
}

async function doctor(endpoint = 'http://127.0.0.1:9222') {
  let version, tabs;
  try {
    [version, tabs] = await Promise.all([
      fetch(`${endpoint}/json/version`).then(r => r.json()),
      fetch(`${endpoint}/json/list`).then(r => r.json())
    ]);
  } catch {
    throw new Error(`CDP 未连接到 ${endpoint}；先执行 browser 命令启动独立 Chrome/Edge，再扫码登录。`);
  }
  return {
    browser: version.Browser,
    endpoint,
    shopTabs: tabs.filter(tab => /^https:\/\/s\.kwaixiaodian\.com\//.test(tab.url || ''))
      .map(tab => ({ title: tab.title, url: tab.url }))
  };
}

module.exports = { browserCandidates, browserPath, profilePath, launchBrowser, doctor };
