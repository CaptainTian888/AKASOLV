#!/usr/bin/env node
// 离线算出每日邀请码，规则和 Worker 完全一致。
//   node tools/invite-code.mjs <INVITE_SALT> [天数]
import { createHash } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

const salt = process.argv[2];
const days = Math.min(366, Math.max(1, Number(process.argv[3] || 1)));
if (!salt) {
  console.error('用法: node tools/invite-code.mjs <INVITE_SALT> [天数]');
  process.exit(1);
}

// 和 Worker 一样固定用东八区，否则两边算出来的"今天"可能差一天。
const dateKey = (offsetDays) =>
  new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);

for (let i = 0; i < days; i++) {
  const date = dateKey(i);
  const digest = createHash('sha256').update(`${date}|${salt}`).digest();
  let code = '';
  for (let n = 0; n < CODE_LENGTH; n++) code += ALPHABET[digest[n] % ALPHABET.length];
  console.log(`${date}  ${code}`);
}
