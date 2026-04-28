#!/bin/bash
# Self-heal disk-pressure script. Must be root-owned, mode 0755.
# Invoked by either: openclaw-watchdog.sh (cron) or directly via sudoers whitelist.
# Behavior is idempotent and non-destructive: every operation either succeeds or no-ops.
set -e
LOG=/var/log/openclaw-disk-heal.log
exec >> "$LOG" 2>&1
echo "=== $(date -Iseconds) disk-heal start ==="
df -h /
journalctl --vacuum-size=200M || true
find /var/log -type f -name '*.log.*' -mtime +14 -delete 2>/dev/null || true
find /var/log -type f -name '*.gz'    -mtime +14 -delete 2>/dev/null || true
mount -o remount,rw / 2>/dev/null || true
df -h /
mount | grep ' / '
echo "=== disk-heal end ==="
