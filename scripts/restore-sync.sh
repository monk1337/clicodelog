#!/usr/bin/env bash
# restore-sync.sh — bidirectional additive sync for Claude Code logs.
#
# Step 1: copy NEW files from ~/.claude/projects/ → ~/.clicodelog/data/claude-code/
# Step 2: copy files that exist only in the backup back into ~/.claude/projects/
#
# Both passes are additive + no-clobber: nothing already at the destination is
# overwritten. Net effect: both folders converge to the UNION of their contents
# — sessions Claude pruned upstream get restored from backup, sessions Claude
# just created get archived to backup.
#
# On APFS (default macOS), copies use clonefile (cp -c): the destination shares
# the source's disk blocks copy-on-write, so the backup costs ~0 extra disk
# until a file changes. Logs are append-only, so clones rarely diverge.
#
# Usage:
#   ./scripts/restore-sync.sh                         # all projects
#   ./scripts/restore-sync.sh --dry-run               # preview all, change nothing
#   ./scripts/restore-sync.sh PROJECT                 # only one project folder
#   ./scripts/restore-sync.sh --dry-run PROJECT       # preview one project
#   ./scripts/restore-sync.sh --list                  # list folders only in backup
#
# PROJECT is the encoded folder name, e.g.
#   -Users-stoic-Documents-Projects-ceszero
# A substring also works (e.g. "ceszero") — it matches the first folder
# in either location whose name contains it.

set -uo pipefail

LIVE="$HOME/.claude/projects"
BACKUP="$HOME/.clicodelog/data/claude-code"

DRY=0
PROJECT=""
for arg in "$@"; do
    case "$arg" in
        --dry-run|-n) DRY=1 ;;
        --list)
            echo "Projects present ONLY in backup (deleted from live):"
            comm -23 <(ls "$BACKUP" 2>/dev/null | sort) <(ls "$HOME/.claude/projects" 2>/dev/null | sort) | sed 's/^/  /'
            exit 0 ;;
        *) PROJECT="$arg" ;;
    esac
done

if [[ ! -d "$LIVE" ]]; then
    echo "Live directory not found: $LIVE" >&2
    exit 1
fi
if [[ ! -d "$BACKUP" ]]; then
    echo "Backup directory not found: $BACKUP" >&2
    exit 1
fi

# If a single project was requested, resolve it to an exact folder name and
# scope LIVE/BACKUP down to just that subdirectory.
if [[ -n "$PROJECT" ]]; then
    match=""
    if [[ -d "$BACKUP/$PROJECT" || -d "$LIVE/$PROJECT" ]]; then
        match="$PROJECT"
    else
        # substring match against backup then live
        match=$(ls "$BACKUP" 2>/dev/null | grep -F "$PROJECT" | head -1)
        [[ -z "$match" ]] && match=$(ls "$LIVE" 2>/dev/null | grep -F "$PROJECT" | head -1)
    fi
    if [[ -z "$match" ]]; then
        echo "No project folder matching '$PROJECT' in backup or live." >&2
        exit 1
    fi
    echo "==> Scoped to single project: $match"
    LIVE="$LIVE/$match"
    BACKUP="$BACKUP/$match"
    mkdir -p "$LIVE" "$BACKUP"
fi

# Use APFS clone (-c) when on a Darwin/APFS root; otherwise plain copy.
CP_OPTS="-Rn"
if [[ "$(uname)" == "Darwin" ]] && mount | grep -q "on / (apfs"; then
    CP_OPTS="-Rcn"   # -c = clonefile (copy-on-write), -n = no-clobber, -R = recursive
fi

count_files() { find "$1" -type f 2>/dev/null | wc -l | tr -d ' '; }
folder_size() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

# List files present in $1 but missing (by relative path) in $2.
missing_in() {  # missing_in SRC DST
    comm -23 \
        <(cd "$1" && find . -type f 2>/dev/null | sort) \
        <(cd "$2" && find . -type f 2>/dev/null | sort)
}

LIVE_FILES_BEFORE=$(count_files "$LIVE")
BACKUP_FILES_BEFORE=$(count_files "$BACKUP")

echo "==> Before"
printf "  live:   %5s files  (%s)\n" "$LIVE_FILES_BEFORE" "$(folder_size "$LIVE")"
printf "  backup: %5s files  (%s)\n" "$BACKUP_FILES_BEFORE" "$(folder_size "$BACKUP")"
[[ "$CP_OPTS" == *c* ]] && echo "  mode:   APFS clone (cp -c, copy-on-write)" || echo "  mode:   plain copy"

TO_BACKUP=$(missing_in "$LIVE" "$BACKUP" | wc -l | tr -d ' ')
TO_LIVE=$(missing_in "$BACKUP" "$LIVE" | wc -l | tr -d ' ')

echo
echo "==> Step 1/2: live → backup  ($TO_BACKUP new files)"
echo "==> Step 2/2: backup → live  ($TO_LIVE files to restore)"

if [[ "$DRY" == "1" ]]; then
    echo
    echo "==> DRY RUN — nothing written. Sample of files that would move:"
    echo "  -- into backup --"; missing_in "$LIVE" "$BACKUP" | head -8 | sed 's/^/    /'
    echo "  -- into live --";   missing_in "$BACKUP" "$LIVE" | head -8 | sed 's/^/    /'
    exit 0
fi

echo
echo "==> Copying live → backup…"
cp $CP_OPTS "$LIVE/." "$BACKUP/" 2>/dev/null || true
echo "==> Copying backup → live…"
cp $CP_OPTS "$BACKUP/." "$LIVE/" 2>/dev/null || true

LIVE_FILES_AFTER=$(count_files "$LIVE")
BACKUP_FILES_AFTER=$(count_files "$BACKUP")

echo
echo "==> After"
printf "  live:   %5s files  (%s)   [+%d]\n" "$LIVE_FILES_AFTER" "$(folder_size "$LIVE")" "$((LIVE_FILES_AFTER - LIVE_FILES_BEFORE))"
printf "  backup: %5s files  (%s)   [+%d]\n" "$BACKUP_FILES_AFTER" "$(folder_size "$BACKUP")" "$((BACKUP_FILES_AFTER - BACKUP_FILES_BEFORE))"
