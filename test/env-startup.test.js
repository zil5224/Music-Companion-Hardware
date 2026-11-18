'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
};

test('web service entrypoint reads project-local .env and sends one Bearer prefix to the configured versioned path', async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'zily-env-startup-'));
  const fixture = path.join(scratch, 'project');
  let child;
  let upstream;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    upstream?.closeAllConnections();
    if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const expectedKey = ['synthetic', 'startup', 'auth', 'fixture'].join('-');
  let observed;
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    observed = { path: req.url, method: req.method, model: payload.model,
      authMatches: req.headers.authorization === 'Bearer ' + expectedKey };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const appPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));

  await fs.mkdir(path.join(fixture, 'web'), { recursive: true });
  await fs.cp(path.join(root, 'server'), path.join(fixture, 'server'), { recursive: true });
  await fs.cp(path.join(root, 'web', 'js'), path.join(fixture, 'web', 'js'), { recursive: true });
  await fs.writeFile(path.join(fixture, '.env'), [
    'DEEPSEEK_API_KEY=' + expectedKey,
    'DEEPSEEK_MODEL=synthetic-startup-model',
    'DEEPSEEK_BASE_URL=http://127.0.0.1:' + upstreamPort + '/compatible-mode/v1/',
  ].join('\n'));
  const env = { ...process.env, ZILY_HOST: '127.0.0.1', ZILY_PORT: String(appPort),
    LOCALAPPDATA: scratch, XDG_DATA_HOME: scratch, ZILY_BACKUP_ENABLED: 'false',
    ZILY_BACKUP_DIR: path.join(scratch, 'backups'), NODE_OPTIONS: '' };
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL']) delete env[name];
  child = spawn(process.execPath, [path.join(fixture, 'server', 'server.js')], {
    cwd: scratch, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test web service startup timeout')), 5000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(String(appPort))) finish();
    });
    child.once('exit', () => finish(new Error('Test web service exited before startup')));
    child.once('error', finish);
  });

  const response = await fetch('http://127.0.0.1:' + appPort + '/api/chat', {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '只回复 OK' }] }),
  });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /"content":"OK"/);
  assert.match(stream, /\[DONE\]/);
  assert.deepEqual(observed, { path: '/compatible-mode/v1/chat/completions', method: 'POST',
    model: 'synthetic-startup-model', authMatches: true });
});
