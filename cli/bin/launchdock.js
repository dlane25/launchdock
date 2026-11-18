#!/usr/bin/env node
import * as cmd from '../src/commands.js';

const HELP = `LaunchDock CLI — build, submit and update iOS & Android apps

Usage: launchdock <command> [options]

Account
  login [--url URL] [--email E] [--token T]   Log in to your LaunchDock server
  logout | whoami

Project
  init [--project-id ID]                      Create/link a project and write launchdock.json
  project:info | projects:list

Builds
  build [--platform ios|android|all] [--profile production] [--message M]
        [--auto-submit] [--git [ref]] [--no-wait]
  builds:list [--platform] [--status] [--limit]
  builds:view <id> | builds:logs <id> | builds:cancel <id>

Store submission
  submit [--platform ios|android|all] [--id BUILD_ID] [--profile production]
         [--track internal|alpha|beta|production] [--release-status draft|completed]
         [--groups "Group A,Group B"] [--what-to-test "..."]

Over-the-air updates (expo-updates)
  update:configure                            Point app.json at this server
  update [--channel production] [--message M] [--platform all] [--runtime-version V]
  update:list [--channel C]
  update:rollback --channel C (--to GROUP_ID | --runtime-version V)
  update:signing-key --file keys/private-key.pem   Sign manifests (expo-updates code signing)

Credentials & config
  credentials:list
  credentials:set asc_api_key --key-id K --issuer-id I --file AuthKey_K.p8
  credentials:set google_service_account --file service-account.json
  credentials:set android_keystore --file upload.jks --alias upload [--password P]
  credentials:set ios_distribution_certificate --file dist.p12 [--password P]
  credentials:set ios_provisioning_profile --file app.mobileprovision
  credentials:delete <type>
  credentials:backup-keystore [--out file.jks]  Download the Android upload keystore + passwords
  secrets:set NAME [value] | secrets:list | secrets:delete NAME
  version:set --platform ios|android --build-number N
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let [key, val] = a.slice(2).split(/=(.*)/s);
      if (key.startsWith('no-')) {
        opts[camel(key.slice(3))] = false;
        if (key === 'no-wait') opts.noWait = true;
        continue;
      }
      if (val === undefined) {
        const next = argv[i + 1];
        val = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
      }
      opts[camel(key)] = val;
    } else opts._.push(a);
  }
  return opts;
}
const camel = (s) => s.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

const COMMANDS = {
  login: cmd.login,
  logout: cmd.logout,
  whoami: cmd.whoami,
  init: cmd.init,
  build: cmd.build,
  'builds:list': cmd.buildsList,
  'builds:view': cmd.buildsView,
  'builds:logs': cmd.buildsLogs,
  'builds:cancel': cmd.buildsCancel,
  submit: cmd.submit,
  update: cmd.update,
  'update:configure': cmd.updateConfigure,
  'update:list': cmd.updateList,
  'update:rollback': cmd.updateRollback,
  'update:signing-key': cmd.updateSigningKey,
  'credentials:list': cmd.credentialsList,
  'credentials:set': cmd.credentialsSet,
  'credentials:delete': cmd.credentialsDelete,
  'credentials:backup-keystore': cmd.credentialsBackup,
  'secrets:set': cmd.secretsSet,
  'secrets:list': cmd.secretsList,
  'secrets:delete': cmd.secretsDelete,
  'version:set': cmd.versionSet,
  'project:info': cmd.projectInfo,
  'projects:list': cmd.projectsList,
};

const [name, ...rest] = process.argv.slice(2);
if (!name || name === 'help' || name === '--help' || name === '-h') {
  console.log(HELP);
  process.exit(0);
}
const fn = COMMANDS[name];
if (!fn) {
  console.error(`Unknown command "${name}". Run: launchdock help`);
  process.exit(1);
}
fn(parseArgs(rest)).catch((err) => {
  console.error(`\x1b[31m✖ ${err.message}\x1b[0m`);
  process.exit(1);
});
