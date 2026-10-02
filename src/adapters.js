'use strict';
// 模拟适配器：航班动态 + 短信网关。真实部署时替换为航信/航司 API 与短信平台，
// 领域服务只依赖这两个接口。
const { genId, nowIso, maskPhone } = require('./util');

// ---- 航班模拟适配器 ----
// 内置一张可预测的动态表；seed 可注入延误/改降样例。
function createFlightAdapter(presets = {}) {
  // flightNo -> 动态
  const dynamics = new Map(Object.entries(presets));
  return {
    name: 'mock-flight',
    // 返回当前航班动态；无预设时返回原计划正常状态
    getStatus(flight) {
      const flightNo = flight.flightNo || flight.flight_no;
      const d = dynamics.get(flightNo) || {};
      return {
        flightNo,
        status: d.status || 'SCHEDULED',
        depEstimate: d.depEstimate || flight.schedDep || flight.sched_dep,
        arrEstimate: d.arrEstimate || flight.schedArr || flight.sched_arr,
        divertedTo: d.divertedTo || null,
        reason: d.reason || null,
        fetchedAt: nowIso(),
      };
    },
    // 测试/脚本使用：模拟一次新动态
    _inject(flightNo, dynamic) { dynamics.set(flightNo, dynamic); },
  };
}

// ---- 短信模拟适配器 ----
// 不落真实网络；将短信写入 sms_messages 表并回显在界面"异常通知"里。
function createSmsAdapter(db) {
  return {
    name: 'mock-sms',
    send({ registrationId, phone, template, body }) {
      const row = {
        id: genId('sms'),
        registration_id: registrationId,
        to_phone_masked: maskPhone(phone),
        template,
        body,
        status: 'SENT-MOCK',
        created_at: nowIso(),
      };
      db.prepare(`INSERT INTO sms_messages (id, registration_id, to_phone_masked, template, body, status, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(row.id, row.registration_id, row.to_phone_masked, row.template, row.body, row.status, row.created_at);
      return { id: row.id, status: row.status, to: row.to_phone_masked };
    },
  };
}

module.exports = { createFlightAdapter, createSmsAdapter };
