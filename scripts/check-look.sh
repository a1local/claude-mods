#!/bin/sh
# Fails when any mod's hooks/look.tsx differs from STYLE/look.tsx (the shared look; see STYLE/STYLE.md).
#   scripts/check-look.sh          check
#   scripts/check-look.sh --copy   copy STYLE/look.tsx into every mod first
cd "$(dirname "$0")/.." || exit 1
status=0
for mod in */*/.claude-plugin/plugin.json; do
  dir="${mod%/.claude-plugin/plugin.json}"
  [ "$1" = "--copy" ] && cp STYLE/look.tsx "$dir/hooks/look.tsx"
  if ! cmp -s STYLE/look.tsx "$dir/hooks/look.tsx"; then echo "differs or missing: $dir/hooks/look.tsx"; status=1; fi
done
[ $status -eq 0 ] && echo "look.tsx identical in every mod"
exit $status
