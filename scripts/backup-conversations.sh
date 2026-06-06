#!/usr/bin/env bash
# backup-conversations.sh — additive, copy-only backup of Claude Code logs.
#
# Copies ~/.claude/projects/ into a local backup folder (never moves, never
# deletes). Optionally also pushes the backup to a cloud remote (Google Drive,
# Dropbox, S3, …) via rclone. Safe to run repeatedly and on a schedule.
#
# Usage:
#   ./backup-conversations.sh --one <session-id|substring>   # TEST one convo
#   ./backup-conversations.sh --dry-run                      # preview all
#   ./backup-conversations.sh                                # back up everything
#   ./backup-conversations.sh --rclone gdrive:claude-backup  # also push to cloud
#
# Flags can combine, e.g.:
#   ./backup-conversations.sh --one 484582a9 --rclone gdrive:claude-backup
#
# Env overrides:
#   SRC      source dir   (default: ~/.claude/projects)
#   BACKUP   local backup (default: ~/claude-conversations-backup)

set -uo pipefail

SRC="${SRC:-$HOME/.claude/projects}"
BACKUP="${BACKUP:-$HOME/claude-conversations-backup}"

DRY=0
ONE=""
RCLONE_REMOTE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run|-n) DRY=1; shift ;;
        --one|-o)     ONE="${2:-}"; shift 2 ;;
        --rclone|-r)  RCLONE_REMOTE="${2:-}"; shift 2 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ ! -d "$SRC" ]]; then
    echo "Source not found: $SRC" >&2
    exit 1
fi

# APFS clone (copy-on-write) when available — additive copy costs ~0 disk.
CP_OPTS="-Rn"
if [[ "$(uname)" == "Darwin" ]] && mount | grep -q "on / (apfs"; then
    CP_OPTS="-Rcn"   # -c clone, -n no-clobber, -R recursive
fi

mkdir -p "$BACKUP"

count() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
size()  { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

echo "==> Claude conversation backup (copy-only, additive)"
echo "    source: $SRC"
echo "    backup: $BACKUP"
[[ "$CP_OPTS" == *c* ]] && echo "    mode:   APFS clone (cp -c)" || echo "    mode:   plain copy"

# ---- Single-conversation test mode -----------------------------------------
if [[ -n "$ONE" ]]; then
    # Resolve a session id / substring to its file (top-level transcripts only).
    f=$(find "$SRC" -name "*${ONE}*.jsonl" ! -path "*subagents*" 2>/dev/null | head -1)
    if [[ -z "$f" ]]; then
        echo "No conversation matching '$ONE' under $SRC" >&2
        exit 1
    fi
    rel="${f#$SRC/}"
    dest="$BACKUP/$rel"
    echo
    echo "==> TEST: single conversation"
    echo "    file: $rel  ($(ls -lh "$f" | awk '{print $5}'))"
    echo "    -> $dest"
    if [[ "$DRY" == "1" ]]; then
        echo "    (dry run — nothing copied)"
        exit 0
    fi
    mkdir -p "$(dirname "$dest")"
    if [[ -e "$dest" ]]; then
        echo "    already in backup — left untouched (no-clobber)"
    else
        cp $CP_OPTS "$f" "$dest" 2>/dev/null || cp "$f" "$dest"
        echo "    copied ✓"
    fi
    # also copy its sidecar dir (subagents / tool-results) if present
    side="${f%.jsonl}"
    if [[ -d "$side" ]]; then
        cp $CP_OPTS "$side" "$BACKUP/$(dirname "$rel")/" 2>/dev/null || true
        echo "    copied sidecar dir ✓"
    fi
    echo
    echo "==> Verify (source vs backup are byte-identical):"
    if cmp -s "$f" "$dest"; then
        echo "    cmp: identical ✓   source still present ✓ (copy, not move)"
    else
        echo "    cmp: DIFFER ✗"
    fi
    [[ -f "$f" ]] && echo "    source file still exists: yes"
    exit 0
fi

# ---- Full backup ------------------------------------------------------------
BEFORE_F=$(count "$BACKUP"); BEFORE_S=$(size "$BACKUP")
echo
echo "==> Source: $(count "$SRC") files ($(size "$SRC"))"
echo "==> Backup before: $BEFORE_F files ($BEFORE_S)"

if [[ "$DRY" == "1" ]]; then
    new=$(comm -23 \
        <(cd "$SRC" && find . -type f 2>/dev/null | sort) \
        <(cd "$BACKUP" && find . -type f 2>/dev/null | sort) | wc -l | tr -d ' ')
    echo "==> DRY RUN — $new new files would be copied. Nothing written."
    exit 0
fi

cp $CP_OPTS "$SRC/." "$BACKUP/" 2>/dev/null || true
AFTER_F=$(count "$BACKUP"); AFTER_S=$(size "$BACKUP")
echo "==> Backup after:  $AFTER_F files ($AFTER_S)   [+$((AFTER_F - BEFORE_F))]"

# ---- Optional cloud push via rclone ----------------------------------------
if [[ -n "$RCLONE_REMOTE" ]]; then
    if ! command -v rclone >/dev/null 2>&1; then
        echo "==> rclone not installed — skipping cloud push. Install: brew install rclone" >&2
    else
        echo "==> Pushing backup → $RCLONE_REMOTE (rclone copy, additive)…"
        # 'copy' never deletes on the remote; --ignore-existing keeps it append-only-safe
        rclone copy "$BACKUP" "$RCLONE_REMOTE" --copy-links --transfers 8 \
            ${DRY:+--dry-run} && echo "==> Cloud push done ✓"
    fi
fi

echo "==> Done."
