# DEPLOY.md — self-heal toolkit deploy steps

**Run as root on the VM.** Agent CANNOT execute these steps itself.

## Prerequisite

Get a Discord webhook URL (Server Settings → Integrations → Webhooks) for the ops channel where you want disk-pressure alerts.

## Step 1 — Install the scripts

```bash
sudo install -m 0755 -o root -g root \
  /opt/openclaw/workspace/zuildup/quotation-builder/propose/self-heal/openclaw-disk-heal.sh \
  /usr/local/bin/openclaw-disk-heal.sh

sudo install -m 0755 -o root -g root \
  /opt/openclaw/workspace/zuildup/quotation-builder/propose/self-heal/openclaw-watchdog.sh \
  /usr/local/bin/openclaw-watchdog.sh
```

## Step 2 — Install the sudoers entry

```bash
sudo install -m 0440 -o root -g root \
  /opt/openclaw/workspace/zuildup/quotation-builder/propose/self-heal/sudoers.d-ocplatform-selfheal \
  /etc/sudoers.d/openclaw-selfheal

# Validate (this MUST succeed)
sudo visudo -c -f /etc/sudoers.d/ocplatform-selfheal
```

If validation fails, immediately remove `/etc/sudoers.d/openclaw-selfheal`.

## Step 3 — Install the env file (Discord webhook)

```bash
sudo install -m 0640 -o root -g root \
  /opt/openclaw/workspace/zuildup/quotation-builder/propose/self-heal/default-openclaw-watchdog.env \
  /etc/default/openclaw-watchdog

# Edit it and paste your webhook URL
sudo nano /etc/default/openclaw-watchdog
```

## Step 4 — Install the cron entry

```bash
sudo install -m 0644 -o root -g root \
  /opt/openclaw/workspace/zuildup/quotation-builder/propose/self-heal/cron.d-openclaw-watchdog \
  /etc/cron.d/openclaw-watchdog

# Verify cron picked it up
sudo systemctl reload cron
```

## Step 5 — Smoke test

Manually run the watchdog once to confirm everything works:

```bash
sudo /usr/local/bin/openclaw-watchdog.sh
sudo cat /var/log/openclaw-watchdog.log
```

You should see entries with current disk %. If anything explodes, all 4 install steps are reversible:

```bash
sudo rm /usr/local/bin/openclaw-disk-heal.sh
sudo rm /usr/local/bin/openclaw-watchdog.sh
sudo rm /etc/sudoers.d/openclaw-selfheal
sudo rm /etc/default/openclaw-watchdog
sudo rm /etc/cron.d/openclaw-watchdog
```

## Step 6 — Verify agent can invoke disk-heal directly (without cron)

In the agent session:

```bash
sudo -n /usr/local/bin/openclaw-disk-heal.sh
# Should run with no password prompt, no error.
```

If `sudo -n` returns "a password is required" → the sudoers entry didn't take. Re-check Step 2.

## What this gives you

- Disk-pressure auto-recovery: if root goes RO again, watchdog catches it within 5 min and remounts.
- Proactive cleanup: if disk hits 90%, watchdog runs cleanup.
- Discord alert at 85%: you know about it before it becomes a problem.
- Agent-side recovery: if you tell the agent "run disk-heal" it can `sudo -n /usr/local/bin/openclaw-disk-heal.sh` directly (one narrow privilege).
- Gateway restart: only the cron does this — the agent can't restart its own service.

## What this does NOT solve

- The kernel keeps stale dentry caches even after disk recovery + remount-rw. That's the source of the "phantom-FS" pattern (file appears missing to one syscall but visible to another). The watchdog can't fix that — only a fresh process namespace can. Restarting `openclaw.service` (Step 3 of watchdog) is the workaround when caches are wedged.
