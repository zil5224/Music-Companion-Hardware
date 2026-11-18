'use strict';
/**
 * 对仓库内全部 JavaScript / CommonJS 文件做语法检查。
 * 用法：npm run check（等价于 node scripts/check-syntax.cjs）
 *
 * 只做解析，不执行代码，因此浏览器端脚本（web/js）也可以直接检查。
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'Objects', 'Listings']);
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

const files = [];
(function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
})(ROOT);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed += 1;
    process.stderr.write(`语法错误：${path.relative(ROOT, file)}\n`);
    const detail = (error.stderr || error.stdout || '').toString().trim();
    if (detail) process.stderr.write(detail + '\n');
  }
}

if (failed > 0) {
  process.stderr.write(`${failed} / ${files.length} 个文件未通过语法检查。\n`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个文件。`);