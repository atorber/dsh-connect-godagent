#!/usr/bin/env bash
# dsh-connect-godagent 一键安装脚本
#
# 用法（任选其一，[profile] 默认 web）：
#   curl -fsSL https://raw.githubusercontent.com/atorber/dsh-connect-godagent/main/install.sh | bash -s -- [profile]
# 或克隆仓库后：
#   bash install.sh [profile]
#
# 脚本幂等，可重复执行。完成后需重启 DSH（dsh web）生效。
set -euo pipefail

PLUGIN_ID="dsh-connect-godagent"
REPO_URL="https://github.com/atorber/dsh-connect-godagent.git"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${1:-${DSH_PROFILE:-web}}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "❌ 找不到 profile: $PROFILE_DIR" >&2
  echo "   可用: ls $DSH_HOME/profiles/ ；或传参 install.sh <profile名>" >&2
  exit 1
fi
if [ ! -f "$PROFILE_DIR/cordis.patch.yml" ]; then
  echo "❌ $PROFILE_DIR/cordis.patch.yml 不存在（不是有效的 DSH profile？）" >&2
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || { echo "❌ 需要 pnpm（npm i -g pnpm）" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ 需要 node" >&2; exit 1; }

cd "$PROFILE_DIR"

# 1) git 依赖安装（幂等）
NEED_ADD=$(node -e "const p=require('./package.json');process.stdout.write(p.dependencies&&p.dependencies['dsh-connect-godagent']?'no':'yes')")
if [ "$NEED_ADD" = "yes" ]; then
  echo "==> pnpm add git+https://（约 1 分钟）"
  pnpm add "git+$REPO_URL"
else
  echo "==> 依赖已存在，跳过安装"
fi

# 2) dsh.profile.bundles 追加（幂等）
node -e '
const fs = require("fs");
const ID = "dsh-connect-godagent";
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.dsh = p.dsh || {}; p.dsh.profile = p.dsh.profile || {};
const b = p.dsh.profile.bundles = p.dsh.profile.bundles || [];
if (!b.includes(ID)) { b.push(ID); fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n"); console.log("==> bundles += " + ID); }
else console.log("==> bundles 已包含 " + ID);
'

# 3) cordis.patch.yml 追加挂载条目（幂等）
if ! grep -q "id: $PLUGIN_ID" cordis.patch.yml; then
  printf -- "- id: %s\n  name: %s\n" "$PLUGIN_ID" "$PLUGIN_ID" >> cordis.patch.yml
  echo "==> cordis.patch.yml += $PLUGIN_ID"
else
  echo "==> cordis.patch.yml 已包含 $PLUGIN_ID"
fi

echo ""
echo "✅ 安装完成：${PLUGIN_ID} → profile ${PROFILE}（${PROFILE_DIR}）"
echo "   重启 DSH（dsh web）后生效；GUI「设置 → God Agent」可配置分组与白名单。"
