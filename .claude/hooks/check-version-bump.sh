#!/usr/bin/env bash
# PreToolUse hook (Bash matcher, scoped to `git commit*` via the `if` filter
# in settings.json). Blocks commits that touch momentum-light.user.js without
# bumping the `// @version` line in its userscript header — a missed bump
# means Tampermonkey clients won't fetch the update.
set -u

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# Not in a git repo? Nothing to check.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

FILE="momentum-light.user.js"

# File staged for commit? Otherwise this hook has no opinion.
if ! git diff --cached --name-only | grep -qx "$FILE"; then
  exit 0
fi

# New file (not in HEAD yet) — can't compare, allow through.
if ! git cat-file -e "HEAD:$FILE" 2>/dev/null; then
  exit 0
fi

staged=$(git show ":$FILE" 2>/dev/null | grep -m1 '^// @version')
head=$(git show "HEAD:$FILE" 2>/dev/null | grep -m1 '^// @version')

if [ -n "$head" ] && [ "$staged" = "$head" ]; then
  reason="momentum-light.user.js a été modifié sans bump de version. "
  reason+="Mets à jour la ligne \"// @version\" dans l'en-tête du userscript "
  reason+="(et la chaîne \"version X.Y.Z\" du log de chargement, ligne ~6288) "
  reason+="avant de committer — sans bump, les clients Tampermonkey "
  reason+="ne récupèrent pas la mise à jour via @updateURL."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' \
    "$(printf '%s' "$reason" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  exit 0
fi

exit 0
