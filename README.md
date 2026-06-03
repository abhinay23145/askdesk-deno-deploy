# Hermes-lite on Deno Deploy

This is a Deno Deploy backup for the Cloudflare Hermes-lite Worker.

It keeps the same contract:

- `POST /telegram/webhook`
- `POST /askdesk/heartbeat`
- `GET /askdesk/tasks`
- `POST /askdesk/tasks/<task-id>/result`
- `POST /tasks`
- `GET /tasks/<task-id>`
- `GET /health`

Storage uses Deno KV. The local test path uses an in-memory store.

## Required Deno Environment Variables

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
TELEGRAM_WEBHOOK_SECRET=
ASKDESK_TOKEN=
ADMIN_TOKEN=
MODEL_API_BASE_URL=
MODEL_API_KEY=
MODEL_NAME=
```

`MODEL_*` is optional. Without it, Deno Hermes-lite still receives Telegram tasks, stores queue state, and delegates laptop-local work to AskDesk.

## Local Run

Install Deno first, then:

```powershell
cd C:\Mark-XXXIX-main\JARVIS\deno\hermes-lite
deno task start
```

## Local Test

```powershell
cd C:\Mark-XXXIX-main\JARVIS\deno\hermes-lite
deno task test
```

Verified on this machine with:

```powershell
deno 2.8.1
deno task test
deno check main.js
```

Node portability tests also pass:

```powershell
node --test .\deno\hermes-lite\test\main.test.mjs
```

## Deno Deploy Process

Deno Deploy CLI requires a token for non-interactive deploys from this environment.

The easiest workspace command is:

```powershell
cd C:\Mark-XXXIX-main\JARVIS
$env:DENO_DEPLOY_TOKEN="<paste-deno-deploy-token>"
$env:DENO_DEPLOY_ORG="<paste-deno-org-slug>"
.\scripts\deploy_deno_hermes_lite.ps1
```

It reuses the saved Telegram token, allowed chat ID, and AskDesk token from the local AstraDesk config. It does not switch Telegram or AskDesk away from Cloudflare unless you explicitly run it with `-SwitchTelegramWebhook` or `-SwitchAskDesk`.

Current Windows note:

```text
App/KV/env setup works from this machine.
Local source upload currently fails in Deno CLI on Windows with OS error 123 while reading /C:/... files.
This deployment is now handled by GitHub Actions on Ubuntu.
```

Dry-run check:

```powershell
.\scripts\deploy_deno_hermes_lite.ps1 -DryRun
```

Configure cloud app/KV/env without trying source upload:

```powershell
.\scripts\deploy_deno_hermes_lite.ps1 -SkipDeploy
```

Manual command breakdown:

```powershell
$env:PATH="$env:USERPROFILE\.deno\bin;$env:PATH"
$env:DENO_DEPLOY_TOKEN="<paste-deno-deploy-token>"
$env:DENO_DEPLOY_ORG="<paste-deno-org-slug>"
cd C:\Mark-XXXIX-main\JARVIS\deno\hermes-lite
```

Create the app:

```powershell
deno deploy create --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --source local --runtime-mode dynamic --region global --entrypoint main.js .
```

Provision and assign Deno KV:

```powershell
deno deploy database provision --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG hermes-lite-kv --kind denokv
deno deploy database assign --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk hermes-lite-kv
```

Set required environment variables:

```powershell
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --secret TELEGRAM_BOT_TOKEN "<telegram-bot-token>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk TELEGRAM_ALLOWED_CHAT_IDS "<allowed-chat-ids>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --secret TELEGRAM_WEBHOOK_SECRET "<webhook-secret>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --secret ASKDESK_TOKEN "<askdesk-token>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --secret ADMIN_TOKEN "<admin-token>"
```

Optional model variables:

```powershell
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk MODEL_API_BASE_URL "<model-api-base-url>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --secret MODEL_API_KEY "<model-api-key>"
deno deploy env add --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk MODEL_NAME "<model-name>"
```

Deploy production:

```powershell
deno deploy --token $env:DENO_DEPLOY_TOKEN --org $env:DENO_DEPLOY_ORG --app hermes-lite-askdesk --prod .
```

Check the Deno URL:

```powershell
Invoke-RestMethod "<DENO_URL>/health"
```

## Switch From Cloudflare To Deno

Only switch after Deno `/health` is OK and env vars are confirmed.

Repeatable failover test/switch script from the main workspace:

```powershell
cd C:\Mark-XXXIX-main\JARVIS
.\scripts\test_hermes_lite_failover.ps1 -Target deno -RestoreCloudflare
```

Health-based switch-only mode:

```powershell
.\scripts\test_hermes_lite_failover.ps1 -Target auto -Primary deno -SwitchOnly
```

`auto` uses the selected primary when that primary is healthy and the other host as backup. For the current setup, Deno is the primary because Cloudflare credits are risky.

Install the local Windows monitor for outside use when the laptop is on:

```powershell
.\scripts\install_hermes_lite_failover_monitor.ps1 -Primary deno -IntervalMinutes 5
```

This keeps Telegram and AskDesk pointed at the healthy host. It only restarts AskDesk when the active host actually changes. If the laptop is physically off, Windows cannot run this monitor; Deno remains the active always-on Telegram front door.

Set Telegram webhook to the Deno URL:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<DENO_URL>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Point AskDesk to the Deno URL using the same AskDesk token:

```powershell
.\scripts\save_remote_config.ps1 -HermesLiteUrl "<DENO_URL>" -HermesLiteAskDeskToken "<ASKDESK_TOKEN>"
```

Restart AskDesk remote mode.

To switch back to Cloudflare, set the Telegram webhook and AskDesk Hermes-lite URL back to the Cloudflare Worker URL.

## Source Upload Fallback

Windows CLI source upload failed, so the current working path is GitHub Actions:

- GitHub repo: `https://github.com/abhinay23145/askdesk-deno-deploy`
- Workflow: `.github/workflows/deno-deploy.yml`
- Required GitHub secret: `DENO_DEPLOY_TOKEN`
- Successful runs: `26891911569`, `26892583590`, `26892586240`, `26897139561`
- Live URL: `https://hermes-lite-askdesk.prasanthsanth524.deno.net`

Verify:

```powershell
Invoke-RestMethod "https://hermes-lite-askdesk.prasanthsanth524.deno.net/health"
```

Only switch Telegram/AskDesk after `/health` returns `ok=true`.

## Deno KV Note

Deno KV rejects values larger than 64 KB. AskDesk heartbeat payloads are compacted before storage so large local task histories/model details do not break `/askdesk/heartbeat`.

Verified failover:

```text
Deno task bc1b2802bc7d4a51ad32242ef5214edd completed through Deno -> AskDesk -> Deno.
Deno task 9a9a7c20eced4099a41459d2d0e3f492 completed after queue/recent index parity patch.
Result: Listed 19 item(s).
Normal primary was restored to Cloudflare after the test.
```
