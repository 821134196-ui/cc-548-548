'use strict';
// 测试夹具：内存 SQLite + 最小固定数据集。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createApp } = require('../src/app');
const { seedApp } = require('../src/seed');

// 固定种子（含改降样例），遮罩图写到临时目录
function seededApp() {
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umnr-docs-'));
  const app = createApp(':memory:', {
    MU5318: { status: 'DIVERTED', divertedTo: 'SZX', reason: '海口雷雨' },
  });
  seedApp(app, { docsDir });
  return { ...app, docsDir };
}

// 断言抛出指定错误码
async function expectCode(promiseOrFn, code) {
  let threw = null;
  try {
    const r = typeof promiseOrFn === 'function' ? promiseOrFn() : await promiseOrFn;
    threw = r;
  } catch (e) {
    threw = e;
  }
  if (!threw || threw.code !== code) {
    const got = threw ? `${threw.code || 'NO_CODE'}: ${threw.message}` : '未抛错';
    throw new Error(`期望错误码 ${code}，实际：${got}`);
  }
  return threw;
}

module.exports = { seededApp, expectCode };
