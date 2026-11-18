'use strict';
/**
 * 一键启动全部服务（跨平台，无第三方依赖）：
 *   1. 网易云 API   (默认 3000)
 *   2. Music Companion 后端    (默认 8080，托管网页)
 * 用法：npm start
 * 按 Ctrl+C 会一起关闭。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const minimumNode = require('../package.json').engines.node.slice(2);
const installed = process.versions.node.split('.').map(Number);
const required = minimumNode.split('.').map(Number);
const firstDifference = required.findIndex((part, index) => installed[index] !== part);
if (firstDifference !== -1 && installed[firstDifference] < required[firstDifference]) {
  console.error(`[Music Companion] 需要 Node.js ${minimumNode} 或更新版本，当前版本为 ${process.versions.node}。推荐安装 Node.js 24.x。`);
  process.exit(1);
}
if (!process.features.require_module) {
  console.error('[Music Companion] 启动需要 Node.js 的 require(ESM) 支持。请移除禁用此能力的 Node 启动选项。');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
let localConfig = {};
try {
  localConfig = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('[Music Companion] 无法读取项目 .env。');
    process.exit(1);
  }
}
const ncmPort = process.env.NCM_PORT ?? localConfig.NCM_PORT ?? '3000';
if (!/^\d{1,5}$/.test(ncmPort) || Number(ncmPort) < 1 || Number(ncmPort) > 65535) {
  console.error('[ncm] NCM_PORT 必须是 1 到 65535 的端口号。');
  process.exit(1);
}
const children = [];

function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const tag = `[${name}] `;
  const pipe = (stream, out) => stream.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/)) if (line.trim()) out.write(tag + line + '\n');
  });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('error', () => console.error(`${tag}启动失败`));
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`${tag}已退出（code ${code}）`);
  });
  children.push(child);
  return child;
}

// 1) 网易云 API
const ncmEntry = path.join(ROOT, 'node_modules', 'NeteaseCloudMusicApi', 'app.js');
if (fs.existsSync(ncmEntry)) {
  const env = { ...process.env, PORT: ncmPort };
  const ncmTemp = process.env.ZILY_NCM_TEMP_DIR ?? localConfig.ZILY_NCM_TEMP_DIR;
  if (ncmTemp) {
    try {
      fs.mkdirSync(ncmTemp, { recursive: true });
    } catch (error) {
      console.error('[ncm] 无法创建独立临时目录（' + error.code + '）。');
      process.exit(1);
    }
    env.TEMP = env.TMP = env.TMPDIR = ncmTemp;
  }
  delete env.DEEPSEEK_API_KEY;
  run('ncm', process.execPath, [path.join('scripts', 'ncm.js')], { env });
} else {
  console.error('[ncm] 没找到 NeteaseCloudMusicApi，请先执行 npm ci（Windows 可用 npm.cmd ci）');
}

// 2) Music Companion 后端
run('web', process.execPath, [path.join('server', 'server.js')]);

function shutdown() {
  for (const c of children) { try { c.kill(); } catch { /* ignore */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
