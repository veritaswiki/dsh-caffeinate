#!/usr/bin/env node
/**
 * 脱敏门禁：扫描仓库文本，禁止出现本机绝对路径、私有包前缀、回环地址、内网地址与密钥字样。
 *
 * 用法：node scripts/sanitize-check.mjs
 * 退出码：0 = 干净；1 = 有命中（逐条打印 file:line）。
 *
 * 说明：needle 故意用拼接写法构造，避免本文件被自己的门禁命中——
 * 门禁是对整个仓库做的，写下字面量会自报家门。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2']);
const MAX_BYTES = 2 * 1024 * 1024;

const NEEDLES = [
  { reason: 'absolute home path (macOS)', text: ['', 'Users', ''].join('/') },
  { reason: 'absolute home path (Linux)', text: ['', 'home', ''].join('/') },
  { reason: 'private package scope', text: '@' + 'local' },
  { reason: 'loopback IPv4 address', text: [127, 0, 0, 1].join('.') },
  { reason: 'loopback hostname', text: 'local' + 'host' },
  { reason: 'private key material', text: 'PRIVATE' + ' KEY' },
  { reason: 'personal home path', text: ['Users', 'f', ''].join('/') },
  { reason: 'tailscale / internal IP', text: [100, ''].join('.') },
  { reason: 'internal gateway name', text: 'mag' + 'pie' },
  { reason: 'cloud vendor host', text: 'cty' + 'un' },
  { reason: 'api key prefix', text: 's' + 'k-' },
  { reason: 'github token prefix', text: 'gh' + 'o_' },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    const dot = name.lastIndexOf('.');
    if (dot > 0 && SKIP_EXT.has(name.slice(dot).toLowerCase())) continue;
    out.push(join(dir, name));
  }
  return out;
}

const hits = [];

for (const file of walk(ROOT)) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // 二进制

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const needle of NEEDLES) {
      if (!line.includes(needle.text)) continue;
      hits.push(`${relative(ROOT, file)}:${i + 1}: ${needle.reason}`);
    }
  }
}

if (hits.length === 0) {
  console.log('sanitize-check: clean (0 hits)');
  process.exit(0);
}

console.error(`sanitize-check: ${hits.length} hit(s)`);
for (const hit of hits) console.error(`  ${hit}`);
process.exit(1);
