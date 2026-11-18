'use strict';

const NCM_ALLOWED = new Set([
  '/login/qr/key',
  '/login/qr/create',
  '/login/qr/check',
  '/cloudsearch',
  '/song/url',
  '/lyric',
]);

module.exports = { NCM_ALLOWED };
