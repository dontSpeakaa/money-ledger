#!/usr/bin/env bash
# 把账本推到 GitHub，并开启 GitHub Pages（纯手机本地模式）。
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx ./scripts/deploy-pages.sh [仓库名]
#
# 令牌需要 repo 权限（创建仓库、推送、配置 Pages）。
# 如果仓库已经存在，脚本会跳过创建、直接推送。

set -u

OWNER="${GITHUB_OWNER:-dontSpeakaa}"
REPO="${1:-money-ledger}"
BRANCH=main
API=https://api.github.com

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "缺少 GITHUB_TOKEN。用法：GITHUB_TOKEN=ghp_xxx $0 [仓库名]" >&2
  exit 1
fi

api() {
  local method="$1" path="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "$API$path" -d "$data"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "$API$path"
  fi
}

echo "==> 检查仓库 $OWNER/$REPO"
if api GET "/repos/$OWNER/$REPO" | grep -q '"full_name"'; then
  echo "    已存在，跳过创建"
else
  echo "    不存在，正在创建…"
  out=$(api POST /user/repos "{\"name\":\"$REPO\",\"description\":\"个人理财账本 PWA：零依赖，数据只存在自己手机上\",\"private\":false,\"has_wiki\":false}")
  if echo "$out" | grep -q '"full_name"'; then
    echo "    创建成功"
  else
    echo "    创建失败：$(echo "$out" | head -c 300)" >&2
    echo "    令牌缺少创建仓库的权限，请换一个有 repo 权限的令牌重试。" >&2
    exit 1
  fi
fi

echo "==> 生成静态产物 docs/"
npm run build:static >/dev/null || { echo "构建失败" >&2; exit 1; }

echo "==> 推送 $BRANCH"
git remote remove origin 2>/dev/null || true
git remote add origin "https://${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git"
git add -A
git diff --cached --quiet || git commit -q -m "部署账本静态产物"
git push -q -f origin "$BRANCH"

echo "==> 开启 GitHub Pages（/docs 目录）"
# 已经开过会返回 409，忽略即可。
api POST "/repos/$OWNER/$REPO/pages" "{\"source\":{\"branch\":\"$BRANCH\",\"path\":\"/docs\"}}" >/dev/null || true

echo
echo "完成！"
echo "  仓库：https://github.com/$OWNER/$REPO"
echo "  网址：https://$OWNER.github.io/$REPO/"
echo "  首次发布需要等 1~2 分钟。"
