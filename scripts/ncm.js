'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const categories = new Set(['request_error', 'listening', 'dependency_notice', 'dependency_error', 'worker_exception']);

function runNcm(entry) {
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  delete env.NODE_OPTIONS;
  env.HOST = '127.0.0.1';
  // The browser uses the web service's same-origin proxy.
  env.CORS_ALLOW_ORIGIN = 'https://local-only.invalid';
  const worker = fork(entry, [], {
    env, execArgv: ['--require', path.join(__dirname, 'ncm-log.js')],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  const report = (category, status) => console.warn('[ncm]', JSON.stringify({ stage: 'music_service', category, status }));
  worker.on('message', message => {
    if (!categories.has(message?.category)) return;
    const status = Number.isInteger(message.status) && message.status >= 100 && message.status <= 599 ? message.status : undefined;
    report(message.category, status);
  });
  worker.on('error', () => report('worker_start_failed'));
  return worker;
}

if (require.main === module) {
  try {
    const worker = runNcm(require.resolve('NeteaseCloudMusicApi/app.js'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => worker.kill());
    worker.once('exit', code => { process.exitCode = code ?? 1; });
  } catch {
    console.error('[ncm] {"stage":"music_service","category":"startup_failed"}');
    process.exitCode = 1;
  }
}

module.exports = { runNcm };
