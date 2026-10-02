'use strict';
// 一条命令启动：node src/main.js  （= npm start）
// 自动建库、播种（含改降 SZX + 授权变更样例）并开启 Web 交接台。
const path = require('node:path');
const { createApp } = require('./app');
const { seedApp } = require('./seed');
const { createServer } = require('./server');

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = path.join(__dirname, '..', 'data', 'umnr.sqlite');
const DOCS_DIR = path.join(__dirname, '..', 'data', 'docs');

const app = createApp(DATA_FILE, {
  // 小熊猫 MU5318 的改降动态（航班模拟适配器）
  MU5318: { status: 'DIVERTED', divertedTo: 'SZX', reason: '海口雷雨' },
});
seedApp(app, { docsDir: DOCS_DIR });

const server = createServer(app);
server.listen(PORT, () => {
  console.log('');
  console.log('  ✈  UMNR 无成人陪伴儿童交接链（模拟系统）已启动');
  console.log(`     交接台：  http://localhost:${PORT}/`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  · 小海豚 CA1831 PEK→PVG：待柜台核验签发（完整链路演练）');
  console.log('  · 小熊猫 MU5318 CAN→HAK：已改降 SZX，接机授权 v1 已失效 / v2 有效（改降样例）');
  console.log('  · 右上切换岗位视角：王值机(PEK) → 李地勤(PEK) → 周乘务长 → 褚到达/卫经理(SZX)');
  console.log('');
});
