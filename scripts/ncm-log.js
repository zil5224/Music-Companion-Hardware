'use strict';

// Loaded only in the isolated music worker. No dependency arguments cross IPC.
const http = require('node:http');
const { NCM_ALLOWED } = require('../server/ncm-routes');

// Express uses http.createServer when the vendor starts its local listener.
const createServer = http.createServer;
http.createServer = function (options, listener) {
  const handle = typeof options === 'function' ? options : listener;
  if (typeof handle !== 'function') return createServer.apply(this, arguments);
  const guarded = function (req, res) {
    const port = req.socket.localPort;
    const allowedHost = req.headers.host === '127.0.0.1:' + port || req.headers.host === 'localhost:' + port;
    if (!allowedHost || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      res.writeHead(403).end();
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { res.writeHead(400).end(); return; }
    if (!NCM_ALLOWED.has(url.pathname) || url.searchParams.has('proxy') || !['GET', 'POST'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    return handle.call(this, req, res);
  };
  return typeof options === 'function' ? createServer.call(this, guarded) : createServer.call(this, options, guarded);
};
const send = (category, status) => {
  if (!process.connected) return;
  process.send({ category, status }, () => {});
};
console.log = (label, _url, response) => {
  if (label === '[OK]') return;
  if (label === '[ERR]') {
    const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    send('request_error', status);
  } else if (typeof label === 'string' && label.startsWith('server running @ ')) {
    send('listening');
  } else {
    send('dependency_notice');
  }
};
console.error = console.warn = () => send('dependency_error');
process.on('uncaughtExceptionMonitor', () => send('worker_exception'));
process.on('disconnect', () => process.exit(0));
