# LaunchDock

**Self-hosted build, submit and over-the-air update platform for iOS and Android apps** — an Expo EAS–style service you own. Built by 4ARO Group.

```
 launchdock CLI ─┐                       ┌─► Android worker (Docker / Linux) ──► Google Play
 Dashboard ──────┼──► API + Postgres ────┤
 GitHub/CI ──────┘    (queue, vault,     └─► iOS worker (Mac / GitHub macOS runner) ──► App Store Connect / TestFlight
                       OTA updates)  ◄──── expo-updates in your shipped apps
```

| EAS feature | LaunchDock |
|---|---|
| `eas build` | `launchdock build` — Expo, React Native, Flutter and native Gradle/Xcode projects |
| `eas submit` | `launchdock submit` / `--auto-submit` — Google Play tracks + App Store Connect upload and TestFlight groups |
| `eas update` | `launchdock update` — implements the Expo Updates protocol (v0 + v1), code signing, rollback, republish |
| Managed credentials | Encrypted vault (AES-256-GCM). Auto-generates the Android upload keystore. iOS automatic signing via ASC API key, or manual .p12 + profile |
| Remote versioning | Server auto-increments `versionCode` / `CFBundleVersion` per build |
| Build profiles & channels | `launchdock.json` profiles with `extends`; channel baked into the native build |
| Internal distribution | Signed share links + install page (APK download, iOS ad-hoc `itms-services`) |
| Secrets / env | Per-project write-only secrets injected into builds; masked in logs |
| Dashboard, teams, webhooks | Built-in SPA, owner/admin/developer/viewer roles, HMAC-signed webhooks |

---

## 1. Run the server

Needs Docker Desktop (works on Windows).

```powershell
git clone https://github.com/dlane25/launchdock.git
cd launchdock
copy .env.example .env      # then fill MASTER_KEY, JWT_SECRET, WORKER_TOKEN, PUBLIC_URL
docker compose up -d --build
```

Generate secrets with `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
**Back up `MASTER_KEY`** — it decrypts every keystore and certificate in the vault.

Open `http://localhost:8080` — the first account you create becomes the admin. After that, registration is closed and admins invite users (Account → Users), unless `ALLOW_REGISTRATION=true`.

### Put it on the internet (required for OTA updates and cloud workers)

Phones fetch updates over HTTPS, and GitHub runners must reach the API. With your Cloudflare account:

```powershell
cloudflared tunnel login
cloudflared tunnel create launchdock
cloudflared tunnel route dns launchdock ship.4aro.com
cloudflared tunnel run --url http://localhost:8080 launchdock
```

Set `PUBLIC_URL=https://ship.4aro.com` in `.env` and restart. For production, run the server on a small VPS instead of your desktop, and use `STORAGE_DRIVER=s3` with Cloudflare R2 for artifacts.

## 2. Build workers

**Android** — `docker compose` already starts one (`android-worker`). Scale with `docker compose up -d --scale android-worker=3`. Set `INSTALL_FLUTTER: "true"` in the compose file for Flutter apps.

**iOS** — needs macOS + Xcode. Two options:

- **No Mac (recommended for you):** push this repo to GitHub, add repo secrets `LAUNCHDOCK_URL` and `LAUNCHDOCK_WORKER_TOKEN`, then set `GITHUB_DISPATCH_REPO`, `GITHUB_DISPATCH_TOKEN` in `.env`. Every queued iOS job starts `.github/workflows/launchdock-worker.yml` on a `macos-15` runner, which drains the queue and exits. Pay-per-minute, nothing to maintain.
- **Your own Mac / cloud Mac (MacStadium, AWS EC2 Mac, Scaleway):** `./macos/install-worker.sh https://ship.4aro.com <WORKER_TOKEN>` installs a LaunchAgent that runs permanently.

Workers appear under **Build workers** in the dashboard. Any machine with Node 20+ can be a worker: `LAUNCHDOCK_URL=… WORKER_TOKEN=… node worker/src/index.js` (`--once` for one job, `--drain` to empty the queue and exit).

## 3. Install the CLI

```powershell
npm install -g ./cli          # from this repo (or publish launchdock-cli to npm)
launchdock login --url https://ship.4aro.com
```

## 4. Set up an app

```powershell
cd C:\Users\darre\OneDrive\Desktop\Projects\MyApp
launchdock init                    # creates the project, writes launchdock.json
```

### Apple credentials
App Store Connect → Users and Access → Integrations → **App Store Connect API** → generate a key with the **App Manager** (or Admin) role. Download `AuthKey_XXXX.p8` (only downloadable once).

```powershell
launchdock credentials:set asc_api_key --key-id XXXX --issuer-id <issuer-uuid> --file AuthKey_XXXX.p8
```

Then set your **Apple Team ID** in the project settings. That's enough: builds use Xcode automatic signing with the API key (Xcode creates/renews the distribution certificate and profiles itself), and the same key uploads to TestFlight. Prefer to manage signing yourself? Upload a `.p12` + `.mobileprovision` (`ios_distribution_certificate`, `ios_provisioning_profile`) and LaunchDock switches to manual signing.

### Google credentials
1. Create the app in Play Console and **upload the first build by hand** (Google's API can't create apps). Use the `.aab` from your first LaunchDock build.
2. Google Cloud → IAM → Service accounts → create one → Keys → add JSON key.
3. Play Console → Users and permissions → invite the service account email with release permissions.

```powershell
launchdock credentials:set google_service_account --file play-service-account.json
```

The Android upload keystore is generated automatically on the first build. **Download a backup** (`launchdock credentials:backup-keystore` or dashboard → Credentials). If your app is already on Play, upload your existing keystore instead: `launchdock credentials:set android_keystore --file upload.jks --alias upload`.

If the app is already in the stores, sync build numbers once: `launchdock version:set --platform android --build-number 57`.

## 5. Ship

```powershell
launchdock build --platform all                       # production store builds
launchdock build --platform android --profile preview # APK + install link for testers
launchdock build --platform all --auto-submit         # build, then submit to both stores
launchdock submit --platform ios --groups "Internal Testers" --what-to-test "New levels"
launchdock submit --platform android --track production --release-status inProgress
launchdock builds:list
```

Builds can also come straight from Git: add the repo URL (and a token for private repos) in project settings, then use **New build** in the dashboard or `launchdock build --git main`.

## 6. Over-the-air updates (Expo apps)

```powershell
npx expo install expo-updates
launchdock update:configure        # sets updates.url + runtimeVersion in app.json
launchdock build --platform all    # ship a native build that knows about the server
# later, JS-only changes:
launchdock update --channel production --message "Fix checkout crash"
launchdock update:rollback --channel production --to <groupId>              # republish an older update
launchdock update:rollback --channel production --runtime-version 1.2.0     # back to the embedded bundle
```

Each build profile's `channel` is written into the native app, so `preview` builds only receive `preview` updates. Runtime versions are resolved with `expo-updates runtimeversion:resolve` (supports `appVersion`, `nativeVersion`, `fingerprint`, or a fixed string).

**Code signing (recommended):** `npx expo-updates codesigning:generate --key-output-directory keys --certificate-output-directory certs --certificate-validity-duration-years 10 --certificate-common-name "4ARO"`, then `npx expo-updates codesigning:configure`, and run `launchdock update:signing-key --file keys/private-key.pem`. Manifests are then signed with RSA-SHA256 and the app rejects anything not signed by you.

## launchdock.json

```jsonc
{
  "projectId": "…",
  "build": {
    "base": { "node": "22", "env": { "EXPO_PUBLIC_API_URL": "https://api.4aro.com" } },
    "production": {
      "extends": "base",
      "channel": "production",
      "android": { "buildType": "app-bundle" },        // or "apk"; also gradleCommand, appModule, variant, flavor
      "ios": { "distribution": "store" }               // store | ad-hoc | development | enterprise; scheme, buildConfiguration, signing
    },
    "preview": { "extends": "production", "channel": "preview", "android": { "buildType": "apk" }, "ios": { "distribution": "ad-hoc" } }
  },
  "submit": {
    "production": {
      "android": { "track": "internal", "releaseStatus": "draft", "rollout": 0.1, "releaseNotes": "…" },
      "ios": { "groups": ["Internal Testers"], "whatToTest": "…" }
    }
  }
}
```

Profile-level keys like `projectDir` (monorepos), `projectType` (`expo` | `react-native` | `flutter` | `native`) and `prebuild` apply to both platforms. Set `autoIncrement: false` or a fixed `buildNumber` per platform to opt out of remote versioning.

## CI (deploy from GitHub on push)

```yaml
- run: npm install -g launchdock-cli
- run: launchdock build --platform all --auto-submit --no-wait
  env:
    LAUNCHDOCK_URL: https://ship.4aro.com
    LAUNCHDOCK_TOKEN: ${{ secrets.LAUNCHDOCK_TOKEN }}   # Account → API tokens
```

## Webhooks

Project → Settings → Webhooks. Events: `build.started|finished|errored|canceled`, `submission.finished|errored`, `update.published`. Each POST carries `x-launchdock-signature: sha256=<hmac of body with your secret>`.

## Security model

- Credentials and secrets are encrypted at rest with AES-256-GCM (`MASTER_KEY`) and only decrypted into the claim response for the worker running that job; workers delete their work directory after every job and mask secrets in logs.
- iOS manual signing uses a throwaway keychain that's deleted after the build.
- Workers authenticate with `WORKER_TOKEN`; a job can only be touched by the worker that claimed it. Jobs whose worker stops heart-beating for 10 minutes are failed automatically.
- Artifact links are HMAC-signed and expire (default 7 days).
- Run the server behind HTTPS (Cloudflare Tunnel or a reverse proxy).

## Known limits

- Google Play: the first release of a new app must be uploaded manually; apps that were never published must use `releaseStatus: "draft"`.
- Manual iOS signing handles one provisioning profile (the main app target). Apps with extensions (widgets, notification service) should use automatic signing.
- App Store uploads use `xcrun altool` on the macOS worker. App Store *review submission* (metadata, screenshots) is still done in App Store Connect.

## Layout

```
server/   API, dashboard (public/), Postgres migrations
worker/   build worker (Android + iOS builders, Play + App Store submitters)
cli/      launchdock CLI
docker/   Dockerfiles · macos/ Mac worker installer · .github/ on-demand worker workflow
```
