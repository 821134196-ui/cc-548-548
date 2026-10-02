'use strict';
// 应用装配：打开 SQLite，装载模拟航班/短信适配器与领域服务。
const path = require('node:path');
const { openDb } = require('./db');
const { createFlightAdapter, createSmsAdapter } = require('./adapters');
const { createService } = require('./service');

function createApp(dbFile = path.join(__dirname, '..', 'data', 'umnr.sqlite'), flightPresets = {}) {
  const db = openDb(dbFile);
  const flightAdapter = createFlightAdapter(flightPresets);
  const smsAdapter = createSmsAdapter(db);
  const service = createService(db, { flightAdapter, smsAdapter });
  return { db, flightAdapter, smsAdapter, service };
}

module.exports = { createApp };
