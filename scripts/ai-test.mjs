/*
 * AI 记账助手测试：工具执行 + AI 接口配置 + 转发给服务商的那一层。
 *
 * 工具跑的是真实业务逻辑（public/local-api.js 的完整实现，内存 driver），
 * 只有「服务商返回的 HTTP 响应」是假的 —— 那一步必须联网，不能真调。
 *
 * 用法：node scripts/ai-test.mjs
 */
import { createLocalApi, memoryDriver } from '../public/local-api.js';
import {
  AI_TOOLS,
  buildSystemPrompt,
  normalizeDate,
  pickAccount,
  runTool,
} from '../public/ai-tools.js';

let pass = 0;
let fail = 0;
const check = (desc, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${desc}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${desc}\n      得到 ${a}\n      期望 ${e}`);
    fail += 1;
  }
};
const ok = (desc, cond) => check(desc, !!cond, true);

async function expectError(desc, fn, status) {
  try {
    await fn();
    check(desc, '没有报错', `错误 ${status}`);
  } catch (err) {
    check(desc, err.status, status);
  }
}

/** 假的 OpenAI 兼容接口：记录请求，按 handler 返回。 */
function stubProvider(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const out = (await handler(body, calls.length)) || {};
    return {
      ok: (out.status || 200) < 400,
      status: out.status || 200,
      text: async () => JSON.stringify(out.json ?? {}),
    };
  };
  return calls;
}

const TODAY = '2026-11-27';

const api = createLocalApi(memoryDriver());
const call = (path, opts) => api.handle(path, opts);

console.log('== 1. 工具定义与提示词 ==');

const names = AI_TOOLS.map((t) => t.function.name);
for (const n of [
  'record_transaction',
  'get_daily_summary',
  'get_month_summary',
  'list_transactions',
  'list_accounts',
  'create_account',
  'update_account',
  'delete_account',
  'transfer_money',
  'delete_transaction',
]) {
  ok(`工具 ${n} 已注册`, names.includes(n));
}
ok('每个工具都有 JSON Schema', AI_TOOLS.every((t) => t.function.parameters?.type === 'object'));
check('日期「今天」归一化', normalizeDate('今天', TODAY), TODAY);
check('日期「昨天」归一化', normalizeDate('昨天', TODAY), '2026-11-26');
check('日期斜杠归一化', normalizeDate('2026/1/5', TODAY), '2026-01-05');
check('按名字挑账户', pickAccount([{ name: '招商银行' }, { name: '微信' }], '招行')?.name, '招商银行');
check('挑不到返回 null', pickAccount([{ name: '微信' }], '支付宝'), null);

await call('/api/setup', { method: 'POST', body: { username: 'me', password: 'secret123' } });
const bank = (await call('/api/accounts', { method: 'POST', body: { name: '招商银行', initial_balance: 10000 } })).id;
await call('/api/accounts', { method: 'POST', body: { name: '微信', type: 'wechat', initial_balance: 200 } });
await call('/api/accounts', { method: 'POST', body: { name: '信用卡', type: 'credit', initial_balance: -1500 } });

const prompt = buildSystemPrompt({
  accounts: (await call('/api/accounts')).accounts,
  categories: (await call('/api/categories')).categories,
  today: TODAY,
});
ok('提示词带今天日期', prompt.includes(TODAY));
ok('提示词带账户余额', prompt.includes('招商银行'));
ok('提示词带支出分类', prompt.includes('餐饮'));
ok('提示词带收入分类', prompt.includes('工资'));

console.log('== 2. 记账工具（自动归类） ==');

const recorded = await runTool(
  'record_transaction',
  {
    items: [
      { amount: 38, direction: 'expense', category: '餐饮', note: '午饭' },
      { amount: 6, direction: 'expense', category: '交通', note: '地铁', account: '微信' },
      { amount: 12000, direction: 'income', category: '工资', note: '月薪', date: TODAY },
    ],
  },
  call,
  { today: TODAY },
);
check('三笔都记上', recorded.items.length, 3);
check('支出为负、收入为正', recorded.items.map((i) => i.amount), [-38, -6, 12000]);
ok('回执可读', recorded.summary.includes('餐饮') && recorded.summary.includes('交通'));

const listed = await call(`/api/transactions?month=2026-11`);
check('流水条数', listed.total, 3);
check(
  '账户名正确落库',
  listed.transactions.map((t) => t.account_name).sort(),
  ['微信', '招商银行', '招商银行'],
);

const unknownAccount = await runTool(
  'record_transaction',
  { items: [{ amount: 9, direction: 'expense', category: '餐饮', account: '花呗' }] },
  call,
  { today: TODAY },
);
check('不存在的账户不记', unknownAccount.ok, false);
check('并给出原因', unknownAccount.failed[0].reason.includes('花呗'), true);

const noAmount = await runTool(
  'record_transaction',
  { items: [{ amount: 0, direction: 'expense' }] },
  call,
  { today: TODAY },
);
check('金额为 0 被拒', noAmount.ok, false);

console.log('== 3. 查今天收支 ==');

const daily = await runTool('get_daily_summary', {}, call, { today: TODAY });
check('今天收入', daily.income, 12000);
check('今天支出', daily.expense, 44);
check('今天结余', daily.net, 11956);
check('今天笔数', daily.count, 3);
ok('回执含分类小计', daily.summary.includes('餐饮'));

const emptyDay = await runTool('get_daily_summary', { date: '2026-11-01' }, call, { today: TODAY });
check('没记账的日期笔数为 0', emptyDay.count, 0);

const month = await runTool('get_month_summary', { month: '2026-11' }, call);
check('本月支出', month.expense, 44);
check('净资产', month.net_worth, 10000 + 200 - 1500 + 11956);

const found = await runTool('list_transactions', { month: '2026-11', keyword: '地铁' }, call);
check('关键词搜索命中 1 条', found.total, 1);

console.log('== 4. 账户由 AI 配置 ==');

const created = await runTool(
  'create_account',
  { name: '支付宝', type: 'alipay', balance: 520.5 },
  call,
);
ok('新建账户成功', created.ok && created.mutated);
check('重复新建被拦下', (await runTool('create_account', { name: '支付宝' }, call)).ok, false);

const calibrated = await runTool(
  'update_account',
  { account: '招行', balance: 8888 },
  call,
);
check('按名字模糊校准余额', calibrated.balance, 8888);
ok('回执说明是校准', calibrated.summary.includes('校准'));

const renamed = await runTool('update_account', { account: '支付宝', name: '支付宝余额' }, call);
ok('改名成功', renamed.ok);
check(
  '改名后账户列表可见',
  (await runTool('list_accounts', {}, call)).accounts.some((a) => a.name === '支付宝余额'),
  true,
);

const transfer = await runTool(
  'transfer_money',
  { from: '招商银行', to: '信用卡', amount: 1000 },
  call,
  { today: TODAY },
);
ok('转账成功', transfer.ok);
check(
  '转账后信用卡余额',
  (await call('/api/accounts')).accounts.find((a) => a.name === '信用卡').balance,
  -500,
);

const removedAccount = await runTool('delete_account', { account: '支付宝余额' }, call);
ok('删除账户成功', removedAccount.ok);
check(
  '删除后账户数',
  (await call('/api/accounts?all=1')).accounts.length,
  3,
);

console.log('== 5. 删除流水 ==');

const target = (await call('/api/transactions?month=2026-11')).transactions.find(
  (t) => t.note === '地铁',
);
const del = await runTool('delete_transaction', { id: target.id }, call);
ok('删除流水成功', del.ok);
// 今天原有 3 笔，转账又加了转出 / 转入 2 笔，删掉地铁那笔后剩 4 笔。
check(
  '删除后今天笔数',
  (await runTool('get_daily_summary', {}, call, { today: TODAY })).count,
  4,
);

console.log('== 6. AI 接口配置 ==');

const initial = await call('/api/ai/config');
check('初始未配置', initial.ready, false);
check('初始无 Key', initial.has_key, false);
await expectError(
  '地址必须是 http(s)',
  () => call('/api/ai/config', { method: 'POST', body: { base_url: 'ftp://x', model: 'm' } }),
  400,
);
await expectError(
  '有地址没模型被拒',
  () => call('/api/ai/config', { method: 'POST', body: { base_url: 'https://api.x.com/v1' } }),
  400,
);

const saved = await call('/api/ai/config', {
  method: 'POST',
  body: { base_url: 'https://api.deepseek.com/v1/', model: 'deepseek-chat', api_key: 'sk-secret' },
});
check('保存后就绪', saved.ready, true);
check('末尾斜杠被去掉', saved.base_url, 'https://api.deepseek.com/v1');
check('不回传 Key', JSON.stringify(saved).includes('sk-secret'), false);

const kept = await call('/api/ai/config', {
  method: 'POST',
  body: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' },
});
check('只改模型时保留 Key', kept.has_key, true);
check('模型已更新', kept.model, 'deepseek-reasoner');

console.log('== 7. 转发给服务商（假接口） ==');

await expectError(
  '空对话被拒',
  () => call('/api/ai/chat', { method: 'POST', body: { messages: [] } }),
  400,
);

const calls = stubProvider((body) => ({
  json: {
    id: 'chatcmpl-1',
    choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
  },
}));

const reply = await call('/api/ai/chat', {
  method: 'POST',
  body: { messages: [{ role: 'user', content: '你好' }], tools: AI_TOOLS },
});
check('透传模型回复', reply.choices[0].message.content, '好');
check('请求打到 /chat/completions', calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
check('带上 Bearer Key', calls[0].headers.Authorization, 'Bearer sk-secret');
check('模型名取自配置', calls[0].body.model, 'deepseek-reasoner');
check('工具一起转发', calls[0].body.tools.length, AI_TOOLS.length);
check('默认不开流式', calls[0].body.stream, false);

const errorCalls = stubProvider(() => ({
  status: 401,
  json: { error: { message: 'Invalid API key' } },
}));
await expectError(
  '服务商报错转成 502',
  () => call('/api/ai/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } }),
  502,
);
check('错误只发一次', errorCalls.length, 1);

console.log('== 8. 一轮完整对话（模型调工具 → 回填 → 再回答） ==');

let step = 0;
stubProvider((body) => {
  step += 1;
  if (step === 1) {
    return {
      json: {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'record_transaction',
                    arguments: JSON.stringify({
                      items: [
                        { amount: 25.5, direction: 'expense', category: '餐饮', note: '咖啡' },
                      ],
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    };
  }
  // 第二次请求里必须带着 tool 结果，否则模型无法接上下文。
  const toolMsg = body.messages.find((m) => m.role === 'tool');
  return {
    json: {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: toolMsg ? '记好了：餐饮 25.50' : '缺少工具结果',
          },
          finish_reason: 'stop',
        },
      ],
    },
  };
});

async function chatTurn(userText) {
  const messages = [
    { role: 'system', content: buildSystemPrompt({ today: TODAY }) },
    { role: 'user', content: userText },
  ];
  const actions = [];
  for (let i = 0; i < 4; i += 1) {
    const data = await call('/api/ai/chat', { method: 'POST', body: { messages, tools: AI_TOOLS } });
    const msg = data.choices[0].message;
    if (!msg.tool_calls?.length) return { content: msg.content, actions };
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    for (const c of msg.tool_calls) {
      const result = await runTool(c.function.name, JSON.parse(c.function.arguments), call, {
        today: TODAY,
      });
      actions.push({ ok: result.ok !== false, summary: result.summary });
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
  }
  return { content: '超时', actions };
}

const turn = await chatTurn('刚买了杯咖啡 25.5');
ok('模型最终回复带工具结果', turn.content.includes('餐饮 25.50'));
check('产生一条工具回执', turn.actions.length, 1);
const afterChat = await call(`/api/transactions?month=2026-11`);
check(
  '对话里记的账真的落库',
  afterChat.transactions.some((t) => t.note === '咖啡' && t.amount === -25.5),
  true,
);

console.log('== 9. 语音转文字（纯手机模式） ==');

const api2 = createLocalApi(memoryDriver());
const call2 = (path, opts) => api2.handle(path, opts);
await call2('/api/setup', { method: 'POST', body: { username: 'me', password: 'demo123456' } });

const clip = (type = 'audio/webm', text = 'fakeaudio') => new Blob([text], { type });

await expectError(
  '没配置接口时拒绝转写',
  () => call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } }),
  400,
);

await call2('/api/ai/config', {
  method: 'POST',
  body: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', api_key: 'sk-audio' },
});
check('转写模型默认 whisper-1', (await call2('/api/ai/config')).transcribe_model, 'whisper-1');
await expectError(
  '没有录音时拒绝',
  () => call2('/api/ai/transcribe', { method: 'POST', body: {} }),
  400,
);
await expectError(
  '不支持的音频格式被拒',
  () => call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip('audio/x-weird') } }),
  400,
);

let audioCall = null;
globalThis.fetch = async (url, opts) => {
  audioCall = { url, opts };
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: ' 午饭 38 ' }) };
};

const heard = await call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } });
check('返回识别文字', heard.text, '午饭 38');
check('请求打到 /audio/transcriptions', audioCall.url, 'https://api.openai.com/v1/audio/transcriptions');
check('带上 Bearer Key', audioCall.opts.headers.Authorization, 'Bearer sk-audio');
check('默认模型 whisper-1', audioCall.opts.body.get('model'), 'whisper-1');
check('文件名带扩展名', audioCall.opts.body.get('file').name, 'audio.webm');
check('录音原样上传', await audioCall.opts.body.get('file').text(), 'fakeaudio');

await call2('/api/ai/config', {
  method: 'POST',
  body: { transcribe_model: 'gpt-4o-mini-transcribe' },
});
await call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } });
check('可换成别的转写模型', audioCall.opts.body.get('model'), 'gpt-4o-mini-transcribe');
check('聊天模型不受影响', (await call2('/api/ai/config')).model, 'gpt-4o-mini');

// 聊天和语音可以分开配置：DeepSeek 聊天 + OpenAI 转写
await call2('/api/ai/config', {
  method: 'POST',
  body: { base_url: 'https://api.deepseek.com/v1', transcribe_base_url: 'https://api.openai.com/v1/' },
});
await call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } });
check('转写走单独的地址', audioCall.url, 'https://api.openai.com/v1/audio/transcriptions');
check('单独地址末尾斜杠去掉', (await call2('/api/ai/config')).transcribe_base_url, 'https://api.openai.com/v1');
await call2('/api/ai/config', { method: 'POST', body: { transcribe_base_url: '' } });
await call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } });
check('清空后回落到聊天地址', audioCall.url, 'https://api.deepseek.com/v1/audio/transcriptions');

globalThis.fetch = async () => ({
  ok: false,
  status: 400,
  text: async () => JSON.stringify({ error: { message: 'Audio file could not be read' } }),
});
await expectError(
  '服务商报错转成 502',
  () => call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } }),
  502,
);

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ text: '   ' }) });
await expectError(
  '识别结果为空时报错',
  () => call2('/api/ai/transcribe', { method: 'POST', body: { audio: clip() } }),
  502,
);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
