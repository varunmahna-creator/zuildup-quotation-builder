#!/bin/bash
# External watchdog. Runs from cron every 5 min. Lives outside the agent process.
# Behavior:
#   1. If root is ro → invoke disk-heal
#   2. If disk >90% → invoke disk-heal (proactive)
#   3. If disk-heal ran in last 10 min AND we haven't restarted gateway in last 15 min →
#      restart openclaw.service to refresh the agent's mount namespace
#   4. If disk >85% → Discord alert (proactive)

LOG=/var/log/openclaw-watchdog.log
ENV_FILE=/etc/default/openclaw-watchdog
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
exec >> "$LOG" 2>&1
TS=$(date -Iseconds)

# 1. Detect read-only root → heal
if mount | grep ' / ' | grep -q 'ro,'; then
  echo "[$TS] Root is RO — running heal"
  /usr/local/bin/openclaw-disk-heal.sh
fi

# 2. Detect high disk → heal proactively
DISK_PCT=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
if [ "$DISK_PCT" -gt 90 ]; then
  echo "[$TS] Disk at ${DISK_PCT}% — running heal"
  /usr/local/bin/ocplatform-disk-heal.sh
fi

# 3. If heal ran recently and we haven't restarted gateway recently → restart it
if find /var/log/openclaw-disk-heal.log -mmin -10 2>/dev/null | grep -q .; then
  if [ ! -f /tmp/.gateway-restarted-recent ] || [ "$(find /tmp/.gateway-restarted-recent -mmin -15 2>/dev/null)" = "" ]; then
    echo "[$TS] Heal ran recently — restarting gateway"
    systemctl restart openclaw.service
    touch /tmp/.gateway-restarted-recent
  fi
fi

# 4. Alert if disk >85% (proactive)
if [ "$DISK_PCT" -gt 85 ] && [ -n "$DISCORD_WEBHOOK_URL" ]; then
  curl -fsS -X POST "$DISCORD_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"⚠️ openclaw VM disk at ${DISK_PCT}% — auto-cleanup running\"}" || true
fi
