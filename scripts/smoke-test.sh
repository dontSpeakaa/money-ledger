#!/usr/bin/env bash
# 端到端冒烟测试：用真实的 HTTP 请求走一遍核心流程。
set -u

PORT="${PORT:-13099}"
BASE="http://127.0.0.1:${PORT}"
DB_FILE="$(mktemp -d)/test.db"
COOKIES="$(mktemp)"

PORT="$PORT" MONEY_DB="$DB_FILE" node server/index.js > /tmp/money-test.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -f "$COOKIES"' EXIT

for _ in $(seq 1 50); do
  curl -fsS "$BASE/api/health" > /dev/null 2>&1 && break
  sleep 0.2
done

pass=0; fail=0
check() { # check <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1));
  else echo "  ✗ $1 (got '$2', want '$3')"; fail=$((fail+1)); fi
}
jqv() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);const v=$1;console.log(v===undefined?'':v)})"; }

echo "== 1. 首次使用需要初始化 =="
check "setup_required" "$(curl -fsS "$BASE/api/me" | jqv 'o.setup_required')" "true"
check "未登录访问被拒" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/summary")" "401"

echo "== 2. 创建账户与登录 =="
check "弱密码被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"123"}')" "400"
check "初始化成功" "$(curl -fsS -c "$COOKIES" -X POST "$BASE/api/setup" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"secret123"}' | jqv 'o.ok')" "true"
check "重复初始化被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"secret123"}')" "409"

BANK=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' \
  -d '{"name":"招商银行","type":"bank","initial_balance":10000}' | jqv 'o.id')
CARD=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/accounts" -H 'Content-Type: application/json' \
  -d '{"name":"信用卡","type":"credit","initial_balance":-2000}' | jqv 'o.id')
check "创建两个账户" "$([ -n "$BANK" ] && [ -n "$CARD" ] && echo ok)" "ok"

echo "== 3. 消费后资产自动更新 =="
check "初始净资产" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "8000"
curl -fsS -b "$COOKIES" -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' \
  -d "{\"account_id\":$BANK,\"amount\":-38.5,\"category\":\"餐饮\",\"note\":\"午饭\"}" > /dev/null
check "支出 38.5 后净资产" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "7961.5"
check "该账户余额" "$(curl -fsS -b "$COOKIES" "$BASE/api/accounts" | jqv "o.accounts.find(a=>a.id===$BANK).balance")" "9961.5"
check "本月支出合计" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.month_summary.expense')" "38.5"

echo "== 4. 转账不改变净资产 =="
curl -fsS -b "$COOKIES" -X POST "$BASE/api/transfers" -H 'Content-Type: application/json' \
  -d "{\"from_account_id\":$BANK,\"to_account_id\":$CARD,\"amount\":500}" > /dev/null
check "转账后净资产不变" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "7961.5"
check "转入账户余额" "$(curl -fsS -b "$COOKIES" "$BASE/api/accounts" | jqv "o.accounts.find(a=>a.id===$CARD).balance")" "-1500"

echo "== 5. 收入、编辑、删除 =="
TX=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' \
  -d "{\"account_id\":$BANK,\"amount\":20000,\"category\":\"工资\",\"note\":\"月薪\"}" | jqv 'o.id')
check "发薪后净资产" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "27961.5"
curl -fsS -b "$COOKIES" -X PATCH "$BASE/api/transactions/$TX" -H 'Content-Type: application/json' \
  -d '{"amount":21000,"note":"月薪+补贴"}' > /dev/null
check "改金额后净资产" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "28961.5"
curl -fsS -b "$COOKIES" -X DELETE "$BASE/api/transactions/$TX" > /dev/null
check "删除后净资产" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary" | jqv 'o.net_worth')" "7961.5"

echo "== 6. CSV 导入（含重复行去重） =="
CSV=$'日期,金额,分类,备注\n2026-09-01,-12.5,餐饮,早餐\n2026-09-01,-12.5,餐饮,早餐\n2026-09-02,3000,工资,兼职\n'
IMPORT=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/import/csv" -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({csv:process.argv[1],default_account_id:Number(process.argv[2])}))' "$CSV" "$BANK")")
check "导入 2 条" "$(echo "$IMPORT" | jqv 'o.imported')" "2"
check "重复行跳过 1 条" "$(echo "$IMPORT" | jqv 'o.skipped')" "1"
check "重复导入全部跳过" "$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/import/csv" -H 'Content-Type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({csv:process.argv[1],default_account_id:Number(process.argv[2])}))' "$CSV" "$BANK")" | jqv 'o.imported')" "0"
check "预览不写入" "$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/import" -H 'Content-Type: application/json' \
  -d "{\"rows\":[{\"date\":\"2026-09-03\",\"amount\":-99,\"note\":\"预览\"}],\"default_account_id\":$BANK,\"dry_run\":true}" | jqv 'o.imported')" "1"

echo "== 7. 令牌 + 快捷指令接口 =="
TOKEN=$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/token" | jqv 'o.token')
check "拿到令牌" "$([ -n "$TOKEN" ] && echo ok)" "ok"
check "错误令牌被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/quick?token=wrong" \
  -H 'Content-Type: application/json' -d '{"amount":9.9}')" "401"
check "快捷记账（正数默认记为支出）" "$(curl -fsS -X POST "$BASE/api/quick?token=$TOKEN" \
  -H 'Content-Type: application/json' -d '{"amount":66,"category":"购物","note":"快捷指令"}' | jqv 'o.amount')" "-66"
check "GET 方式记账" "$(curl -fsS "$BASE/api/quick?token=$TOKEN&amount=8&category=%E4%BA%A4%E9%80%9A&note=%E5%9C%B0%E9%93%81" | jqv 'o.ok')" "true"
check "JSON body 传令牌" "$(curl -fsS -X POST "$BASE/api/quick" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"amount\":12,\"category\":\"餐饮\"}" | jqv 'o.amount')" "-12"
check "Bearer 头传令牌" "$(curl -fsS -X POST "$BASE/api/quick" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"amount":7}' | jqv 'o.ok')" "true"
check "撤销令牌后失效" "$(curl -fsS -b "$COOKIES" -X DELETE "$BASE/api/token" > /dev/null; \
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/quick?token=$TOKEN" -H 'Content-Type: application/json' -d '{"amount":1}')" "401"

echo "== 8. 预算、导出、登出 =="
curl -fsS -b "$COOKIES" -X POST "$BASE/api/budgets" -H 'Content-Type: application/json' \
  -d '{"category":"餐饮","monthly_limit":500}' > /dev/null
MONTH=$(date +%Y-%m)
check "预算已记录" "$(curl -fsS -b "$COOKIES" "$BASE/api/summary?month=$MONTH" | jqv 'o.budgets.length')" "1"
check "CSV 导出有表头" "$(curl -fsS -b "$COOKIES" "$BASE/api/export.csv" | head -1 | tr -d '\357\273\277\r')" "date,amount,category,note,account"
check "JSON 导出含交易" "$(curl -fsS -b "$COOKIES" "$BASE/api/export.json" | jqv 'o.transactions.length>0')" "true"
check "登出成功" "$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/logout" | jqv 'o.ok')" "true"
check "登出后无权访问" "$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" "$BASE/api/summary")" "401"
check "错误密码登录被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"nope"}')" "401"
check "正确密码登录成功" "$(curl -fsS -c "$COOKIES" -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"secret123"}' | jqv 'o.ok')" "true"

# 手机经局域网用 http 访问时必须能收到可用的会话 Cookie，否则登录后会立刻掉线。
check "http 下 Cookie 不带 Secure" \
  "$(curl -fsS -D - -o /dev/null -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
     -d '{"username":"me","password":"secret123"}' | grep -i '^set-cookie' | grep -ci 'secure')" "0"
check "https 下 Cookie 带 Secure" \
  "$(curl -fsS -D - -o /dev/null -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
     -H 'X-Forwarded-Proto: https' -d '{"username":"me","password":"secret123"}' \
     | grep -i '^set-cookie' | grep -ci 'secure')" "1"

echo "== 9. 修改密码 =="
check "当前密码错误被拒" "$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST "$BASE/api/password" \
  -H 'Content-Type: application/json' -d '{"current_password":"wrong","new_password":"abcdef"}')" "401"
check "新密码过短被拒" "$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -X POST "$BASE/api/password" \
  -H 'Content-Type: application/json' -d '{"current_password":"secret123","new_password":"abc"}')" "400"
check "修改成功" "$(curl -fsS -b "$COOKIES" -X POST "$BASE/api/password" \
  -H 'Content-Type: application/json' -d '{"current_password":"secret123","new_password":"newsecret456"}' | jqv 'o.ok')" "true"
check "旧密码失效" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"secret123"}')" "401"
check "新密码可登录" "$(curl -fsS -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' -d '{"username":"me","password":"newsecret456"}' | jqv 'o.ok')" "true"

echo
echo "通过 $pass 项，失败 $fail 项"
[ "$fail" -eq 0 ]
