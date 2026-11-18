// LaunchDock dashboard — dependency-free SPA with hash routing.
const $app = document.getElementById('app');
const state = { token: localStorage.getItem('ld_token'), user: null, cleanup: [] };

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (d) => {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(d).toLocaleDateString();
};
const dur = (a, b) => {
  if (!a) return '—';
  const s = Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const size = (n) => (n ? (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`) : '—');
const badge = (s) => `<span class="badge ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const platformBadge = (p) => `<span class="badge ${esc(p)}">${p === 'ios' ? 'iOS' : 'Android'}</span>`;

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 4500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(state.token ? { authorization: `Bearer ${state.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const GET = (p) => api('GET', p);
const POST = (p, b) => api('POST', p, b || {});
const PUT = (p, b) => api('PUT', p, b);
const PATCH = (p, b) => api('PATCH', p, b);
const DEL = (p) => api('DELETE', p);

function logout() {
  localStorage.removeItem('ld_token');
  state.token = null;
  state.user = null;
  location.hash = '#/login';
}

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
const fileToText = (file) => file.text();

function formData(form) {
  return Object.fromEntries([...new FormData(form).entries()].filter(([, v]) => !(v instanceof File)));
}

function onSubmit(selector, handler) {
  const form = document.querySelector(selector);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await handler(form, formData(form));
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function on(selector, event, handler) {
  document.querySelectorAll(selector).forEach((el) =>
    el.addEventListener(event, async (e) => {
      try {
        await handler(e, el);
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );
}

// ---------- layout ----------
const LOGO = `<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f7cff"/><path d="M16 6l6 14h-4v6h-4v-6h-4z" fill="white"/></svg>`;

function shell(content, active = '') {
  const u = state.user;
  return `<div class="layout">
    <aside class="sidebar">
      <a class="logo" href="#/">${LOGO} LaunchDock</a>
      <nav class="nav">
        <a href="#/" class="${active === 'projects' ? 'active' : ''}">Projects</a>
        ${u?.isAdmin ? `<a href="#/workers" class="${active === 'workers' ? 'active' : ''}">Build workers</a>` : ''}
        <a href="#/account" class="${active === 'account' ? 'active' : ''}">Account & tokens</a>
      </nav>
      <div class="spacer"></div>
      <div class="small muted" style="padding:8px 10px">${esc(u?.email || '')}<br><a href="#" id="logout">Sign out</a></div>
    </aside>
    <main class="main">${content}</main>
  </div>`;
}

function mount(html) {
  $app.innerHTML = html;
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = (e) => (e.preventDefault(), logout());
}

// ---------- pages ----------
async function loginPage() {
  const status = await GET('/api/auth/status').catch(() => ({}));
  const register = status.registrationOpen && (status.firstUser || location.hash.includes('register'));
  mount(`<div class="auth"><div class="card">
    <div class="logo" style="padding:0 0 18px">${LOGO} LaunchDock</div>
    <h2>${register ? (status.firstUser ? 'Create the admin account' : 'Create account') : 'Sign in'}</h2>
    <form id="f">
      ${register ? '<label>Name</label><input name="name" autocomplete="name">' : ''}
      <label>Email</label><input name="email" type="email" required autocomplete="email">
      <label>Password</label><input name="password" type="password" required minlength="8" autocomplete="${register ? 'new-password' : 'current-password'}">
      <div class="actions"><button class="btn" type="submit">${register ? 'Create account' : 'Sign in'}</button></div>
    </form>
    ${status.registrationOpen && !status.firstUser ? `<p class="small muted">${register ? '<a href="#/login">Have an account? Sign in</a>' : '<a href="#/login/register">Create an account</a>'}</p>` : ''}
  </div></div>`);
  onSubmit('#f', async (_f, data) => {
    const res = await POST(register ? '/api/auth/register' : '/api/auth/login', data);
    state.token = res.token;
    state.user = res.user;
    localStorage.setItem('ld_token', res.token);
    location.hash = '#/';
  });
}

async function projectsPage() {
  const { projects } = await GET('/api/projects');
  mount(shell(`
    <div class="header"><div><h1>Projects</h1><div class="muted">Apps you build, submit and update with LaunchDock</div></div>
      <button class="btn" id="new">+ New project</button></div>
    <div id="newForm" class="card hidden" style="margin-bottom:16px">
      <h2>New project</h2>
      <form id="f" class="grid cols-2">
        <div><label>App name</label><input name="name" required></div>
        <div><label>Apple Team ID</label><input name="appleTeamId" placeholder="ABCDE12345"></div>
        <div><label>iOS bundle identifier</label><input name="iosBundleId" placeholder="com.4aro.myapp"></div>
        <div><label>Android package</label><input name="androidPackage" placeholder="com.aro.myapp"></div>
        <div class="actions"><button class="btn" type="submit">Create project</button></div>
      </form>
    </div>
    ${projects.length ? `<div class="card" style="padding:0"><table>
      <tr><th>Name</th><th>iOS</th><th>Android</th><th>Role</th><th>Last build</th></tr>
      ${projects.map((p) => `<tr class="link" data-href="#/projects/${p.id}"><td><b>${esc(p.name)}</b></td>
        <td class="mono small">${esc(p.iosBundleId || '—')}</td><td class="mono small">${esc(p.androidPackage || '—')}</td>
        <td>${esc(p.role)}</td><td class="muted">${ago(p.lastBuildAt)}</td></tr>`).join('')}
    </table></div>` : `<div class="card empty">No projects yet. Create one here, or run <code>launchdock init</code> in your app folder.</div>`}
  `, 'projects'));
  on('#new', 'click', () => document.getElementById('newForm').classList.toggle('hidden'));
  on('tr.link', 'click', (_e, el) => (location.hash = el.dataset.href));
  onSubmit('#f', async (_f, data) => {
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v));
    const { project } = await POST('/api/projects', clean);
    location.hash = `#/projects/${project.id}`;
  });
}

const DEFAULT_PROFILES = {
  production: { android: { buildType: 'app-bundle' }, ios: { distribution: 'store' }, channel: 'production' },
  preview: { android: { buildType: 'apk' }, ios: { distribution: 'ad-hoc' }, channel: 'preview' },
  development: { android: { buildType: 'apk' }, ios: { distribution: 'development' }, channel: 'development' },
};

async function projectPage(pid, tab = 'builds') {
  const { project: p, stats, versions } = await GET(`/api/projects/${pid}`);
  const tabs = ['builds', 'submissions', 'updates', 'credentials', 'secrets', 'settings'];
  const head = `
    <div class="header"><div><div class="small muted"><a href="#/">Projects</a> /</div><h1>${esc(p.name)}</h1>
      <div class="muted small mono">${esc([p.iosBundleId, p.androidPackage].filter(Boolean).join(' · ') || 'No identifiers set')} · ${esc(p.id)}</div></div>
      <div class="row">${p.gitUrl ? '<button class="btn" id="newBuild">+ New build</button>' : ''}</div></div>
    <div class="grid cols-3" style="margin-bottom:18px">
      <div class="card"><h3>Builds</h3><div class="stat">${stats.builds}</div></div>
      <div class="card"><h3>Store submissions</h3><div class="stat">${stats.submissions}</div></div>
      <div class="card"><h3>OTA updates</h3><div class="stat">${stats.updates}</div></div>
    </div>
    <div id="buildForm" class="card hidden" style="margin-bottom:16px">
      <h2>Build from Git</h2>
      <form id="bf" class="grid cols-3">
        <div><label>Platform</label><select name="platform"><option value="all">iOS + Android</option><option value="ios">iOS</option><option value="android">Android</option></select></div>
        <div><label>Profile</label><select name="profile"><option>production</option><option>preview</option><option>development</option></select></div>
        <div><label>Git ref</label><input name="gitRef" value="main"></div>
        <div><label>Message</label><input name="message" placeholder="optional"></div>
        <div><label>Submit to stores when done</label><select name="autoSubmit"><option value="">No</option><option value="1">Yes</option></select></div>
        <div class="actions"><button class="btn" type="submit">Queue build</button></div>
      </form>
    </div>
    <div class="tabs">${tabs.map((t) => `<a href="#/projects/${pid}/${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}</div>`;

  const body = await ({ builds: buildsTab, submissions: submissionsTab, updates: updatesTab, credentials: credentialsTab, secrets: secretsTab, settings: settingsTab })[tab](p, versions);
  mount(shell(head + body.html, 'projects'));
  on('#newBuild', 'click', () => document.getElementById('buildForm').classList.toggle('hidden'));
  onSubmit('#bf', async (_f, d) => {
    const res = await POST(`/api/projects/${pid}/builds`, {
      platform: d.platform,
      profile: d.profile,
      gitRef: d.gitRef,
      message: d.message || undefined,
      config: DEFAULT_PROFILES[d.profile],
      autoSubmit: !!d.autoSubmit,
      submitConfig: { android: { track: 'internal', releaseStatus: 'draft' }, ios: {} },
    });
    toast(`Queued ${res.builds.length} build(s)`);
    location.hash = `#/builds/${res.builds[0].id}`;
  });
  on('tr.link', 'click', (_e, el) => (location.hash = el.dataset.href));
  body.bind?.();
}

async function buildsTab(p) {
  const { builds } = await GET(`/api/projects/${p.id}/builds?limit=100`);
  if (!builds.length)
    return { html: `<div class="card empty">No builds yet. Run <code>launchdock build</code> from your app folder${p.gitUrl ? ', or use “New build”' : ''}.</div>` };
  return {
    html: `<div class="card" style="padding:0"><table>
      <tr><th>Platform</th><th>Status</th><th>Profile</th><th>Version</th><th>Message</th><th>Duration</th><th>Created</th></tr>
      ${builds.map((b) => `<tr class="link" data-href="#/builds/${b.id}"><td>${platformBadge(b.platform)}</td><td>${badge(b.status)}</td>
        <td>${esc(b.profile)}</td><td class="mono small">${esc(b.appVersion || '—')} (${esc(b.buildNumber || '—')})</td>
        <td class="small">${esc(b.message || (b.gitCommit ? b.gitCommit.slice(0, 7) : ''))}</td>
        <td class="small muted">${dur(b.startedAt, b.finishedAt)}</td><td class="small muted">${ago(b.createdAt)}</td></tr>`).join('')}
    </table></div>`,
  };
}

async function submissionsTab(p) {
  const { submissions } = await GET(`/api/projects/${p.id}/submissions`);
  if (!submissions.length) return { html: `<div class="card empty">No store submissions yet. Open a finished build and press “Submit to store”, or run <code>launchdock submit</code>.</div>` };
  return {
    html: `<div class="card" style="padding:0"><table>
      <tr><th>Platform</th><th>Status</th><th>Destination</th><th>Build</th><th>Created</th></tr>
      ${submissions.map((s) => `<tr class="link" data-href="#/submissions/${s.id}"><td>${platformBadge(s.platform)}</td><td>${badge(s.status)}</td>
        <td class="small">${s.platform === 'android' ? `Play · ${esc(s.config.track)} (${esc(s.config.releaseStatus)})` : `App Store Connect${s.config.groups?.length ? ' · TestFlight: ' + esc(s.config.groups.join(', ')) : ''}`}</td>
        <td class="mono small"><a href="#/builds/${s.buildId}">${s.buildId.slice(0, 8)}</a></td><td class="small muted">${ago(s.createdAt)}</td></tr>`).join('')}
    </table></div>`,
  };
}

async function updatesTab(p) {
  const { updates } = await GET(`/api/projects/${p.id}/updates`);
  const url = `${location.origin}/api/updates/${p.id}/manifest`;
  const groups = [];
  for (const u of updates) {
    let g = groups.find((x) => x.groupId === u.groupId);
    if (!g) groups.push((g = { ...u, platforms: [] }));
    g.platforms.push(u.platform);
  }
  return {
    html: `<div class="card" style="margin-bottom:14px"><h3>expo-updates URL</h3><div class="mono small secret-box">${esc(url)}</div>
      <p class="small muted">Run <code>launchdock update:configure</code> to set this in app.json, then publish with <code>launchdock update --channel production</code>. Builds set the channel from their profile automatically.</p></div>
      ${groups.length ? `<div class="card" style="padding:0"><table>
        <tr><th>Group</th><th>Channel</th><th>Runtime</th><th>Platforms</th><th>Message</th><th>Published</th><th></th></tr>
        ${groups.map((g) => `<tr><td class="mono small">${g.groupId.slice(0, 8)}</td><td>${esc(g.channel)}</td><td class="mono small">${esc(g.runtimeVersion)}</td>
          <td>${g.platforms.map(platformBadge).join(' ')}</td><td class="small">${g.kind === 'rollback' ? badge('rollback') + ' ' : ''}${esc(g.message || '')}</td>
          <td class="small muted">${ago(g.createdAt)}</td>
          <td>${g.kind === 'update' ? `<button class="btn secondary small republish" data-group="${g.groupId}" data-channel="${esc(g.channel)}">Republish</button>` : ''}
              <button class="btn danger small rollback" data-channel="${esc(g.channel)}" data-rv="${esc(g.runtimeVersion)}">Roll back to embedded</button></td></tr>`).join('')}
      </table></div>` : `<div class="card empty">No updates published yet.</div>`}`,
    bind() {
      on('.republish', 'click', async (_e, el) => {
        if (!confirm(`Republish ${el.dataset.group.slice(0, 8)} to "${el.dataset.channel}"?`)) return;
        await POST(`/api/projects/${p.id}/updates/rollback`, { channel: el.dataset.channel, toGroupId: el.dataset.group });
        toast('Republished');
        route();
      });
      on('.rollback', 'click', async (_e, el) => {
        if (!confirm(`Roll back all users on "${el.dataset.channel}" (runtime ${el.dataset.rv}) to the bundle embedded in their build?`)) return;
        await POST(`/api/projects/${p.id}/updates/rollback`, { channel: el.dataset.channel, runtimeVersion: el.dataset.rv });
        toast('Rolled back');
        route();
      });
    },
  };
}

const CRED_FORMS = {
  asc_api_key: `<label>Key ID</label><input name="keyId" required><label>Issuer ID</label><input name="issuerId" required>
    <label>AuthKey_XXXX.p8 file</label><input type="file" name="p8File" accept=".p8" required>`,
  ios_distribution_certificate: `<label>.p12 file</label><input type="file" name="p12File" accept=".p12" required><label>Password</label><input name="password" type="password">`,
  ios_provisioning_profile: `<label>.mobileprovision file</label><input type="file" name="profileFile" accept=".mobileprovision" required>`,
  google_service_account: `<label>Service account JSON key</label><input type="file" name="jsonFile" accept=".json" required>`,
  android_keystore: `<label>Keystore (.jks / .keystore)</label><input type="file" name="ksFile" required><label>Keystore password</label><input name="keystorePassword" type="password" required>
    <label>Key alias</label><input name="keyAlias" required><label>Key password</label><input name="keyPassword" type="password" required>`,
};
const CRED_HELP = {
  asc_api_key: 'App Store Connect → Users and Access → Integrations → App Store Connect API. Role: App Manager or Admin. Enables automatic signing, uploads and TestFlight.',
  ios_distribution_certificate: 'Optional: only for manual signing. Export “Apple Distribution” from Keychain Access as .p12.',
  ios_provisioning_profile: 'Optional: only for manual signing, together with the .p12.',
  google_service_account: 'Google Cloud service account JSON with access granted in Play Console → Users and permissions.',
  android_keystore: 'Optional: if missing, the first Android build generates one and stores it here. Upload yours if the app is already on Play.',
};

async function credentialsTab(p) {
  const { types, credentials } = await GET(`/api/projects/${p.id}/credentials`);
  const html = ['ios', 'android'].map((plat) => `<div class="card"><h2>${plat === 'ios' ? 'iOS' : 'Android'}</h2>
    ${types.filter((t) => t.platform === plat).map((t) => {
      const have = credentials.find((c) => c.type === t.type);
      return `<div class="cred"><div style="flex:1"><b>${esc(t.label)}</b> ${have ? '<span class="badge finished">saved</span>' : ''}
        <div class="small muted">${esc(CRED_HELP[t.type])}</div>
        ${have ? `<div class="small mono muted" style="margin-top:6px">${esc(Object.entries(have.meta).map(([k, v]) => `${k}: ${v}`).join(' · '))} · updated ${ago(have.updatedAt)}</div>` : ''}
        <form class="credForm hidden" data-type="${t.type}" style="margin-top:10px">${CRED_FORMS[t.type]}<div class="actions"><button class="btn" type="submit">Save</button></div></form></div>
        <div class="row"><button class="btn secondary small toggleCred">${have ? 'Replace' : 'Add'}</button>
        ${have && t.type === 'android_keystore' ? '<button class="btn secondary small" id="ksBackup">Download backup</button>' : ''}
        ${have ? `<button class="btn danger small delCred" data-type="${t.type}">Delete</button>` : ''}</div></div>`;
    }).join('')}</div>`).join('');
  return {
    html: `<div class="grid cols-2">${html}</div><p class="small muted">Credentials are encrypted with AES-256-GCM and only decrypted for the worker running your job.</p>`,
    bind() {
      on('#ksBackup', 'click', async () => {
        const k = await GET(`/api/projects/${p.id}/credentials/android_keystore/backup`);
        const bytes = Uint8Array.from(atob(k.keystoreBase64), (ch) => ch.charCodeAt(0));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([bytes]));
        a.download = `${p.slug}-upload.jks`;
        a.click();
        prompt('Store these somewhere safe (password manager). Keystore password / alias / key password:', `${k.keystorePassword} / ${k.keyAlias} / ${k.keyPassword}`);
      });
      on('.toggleCred', 'click', (_e, el) => el.closest('.cred').querySelector('form').classList.toggle('hidden'));
      on('.delCred', 'click', async (_e, el) => {
        if (!confirm(`Delete ${el.dataset.type}? Builds that need it will fail.`)) return;
        await DEL(`/api/projects/${p.id}/credentials/${el.dataset.type}`);
        route();
      });
      document.querySelectorAll('.credForm').forEach((form) =>
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
            const type = form.dataset.type;
            const f = (n) => form.querySelector(`[name=${n}]`).files[0];
            const v = (n) => form.querySelector(`[name=${n}]`).value;
            const data = {
              asc_api_key: async () => ({ keyId: v('keyId'), issuerId: v('issuerId'), p8: await fileToText(f('p8File')) }),
              ios_distribution_certificate: async () => ({ p12Base64: await fileToBase64(f('p12File')), password: v('password') }),
              ios_provisioning_profile: async () => ({ profileBase64: await fileToBase64(f('profileFile')) }),
              google_service_account: async () => ({ json: await fileToText(f('jsonFile')) }),
              android_keystore: async () => ({ keystoreBase64: await fileToBase64(f('ksFile')), keystorePassword: v('keystorePassword'), keyAlias: v('keyAlias'), keyPassword: v('keyPassword') }),
            }[type];
            await PUT(`/api/projects/${p.id}/credentials/${type}`, { data: await data() });
            toast('Saved');
            route();
          } catch (err) {
            toast(err.message, true);
          }
        }),
      );
    },
  };
}

async function secretsTab(p) {
  const { secrets } = await GET(`/api/projects/${p.id}/secrets`);
  return {
    html: `<div class="grid cols-2"><div class="card"><h2>Build secrets</h2><p class="small muted">Injected as environment variables into every build (e.g. <code>SENTRY_AUTH_TOKEN</code>, <code>EXPO_PUBLIC_API_URL</code>). Values are write-only.</p>
      ${secrets.length ? `<table>${secrets.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td class="small muted">${ago(s.createdAt)}</td><td style="text-align:right"><button class="btn danger small delSecret" data-name="${esc(s.name)}">Delete</button></td></tr>`).join('')}</table>` : '<div class="muted">No secrets.</div>'}</div>
      <div class="card"><h2>Add / replace</h2><form id="sf"><label>Name</label><input name="name" pattern="[A-Z_][A-Z0-9_]*" placeholder="MY_SECRET" required>
        <label>Value</label><textarea name="value" rows="3" required></textarea><div class="actions"><button class="btn" type="submit">Save secret</button></div></form></div></div>`,
    bind() {
      onSubmit('#sf', async (_f, d) => {
        await PUT(`/api/projects/${p.id}/secrets/${d.name}`, { value: d.value });
        toast('Saved');
        route();
      });
      on('.delSecret', 'click', async (_e, el) => {
        await DEL(`/api/projects/${p.id}/secrets/${el.dataset.name}`);
        route();
      });
    },
  };
}

async function settingsTab(p, versions) {
  const [{ members }, hooks] = await Promise.all([GET(`/api/projects/${p.id}/members`), GET(`/api/projects/${p.id}/webhooks`).catch(() => null)]);
  const ver = (pl) => versions.find((v) => v.platform === pl)?.build_number ?? 0;
  return {
    html: `<div class="grid cols-2">
      <div class="card"><h2>App settings</h2><form id="pf">
        <label>Name</label><input name="name" value="${esc(p.name)}">
        <label>iOS bundle identifier</label><input name="iosBundleId" value="${esc(p.iosBundleId || '')}">
        <label>Apple Team ID</label><input name="appleTeamId" value="${esc(p.appleTeamId || '')}">
        <label>App Store Connect app ID (optional — looked up from bundle id)</label><input name="ascAppId" value="${esc(p.ascAppId || '')}">
        <label>Android package</label><input name="androidPackage" value="${esc(p.androidPackage || '')}">
        <label>Git repository (https) — enables dashboard builds</label><input name="gitUrl" value="${esc(p.gitUrl || '')}" placeholder="https://github.com/dlane25/my-app.git">
        <label>Git access token ${p.hasGitToken ? '(saved — leave blank to keep)' : ''}</label><input name="gitToken" type="password">
        <div class="actions"><button class="btn" type="submit">Save</button></div></form></div>
      <div class="stack">
        <div class="card"><h2>Build numbers</h2><p class="small muted">Auto-incremented on every build. Set these to the last number already in the stores.</p>
          <form id="vf" class="grid cols-2"><div><label>iOS (last used)</label><input name="ios" type="number" min="0" value="${ver('ios')}"></div>
          <div><label>Android versionCode (last used)</label><input name="android" type="number" min="0" value="${ver('android')}"></div>
          <div class="actions"><button class="btn secondary" type="submit">Update</button></div></form></div>
        <div class="card"><h2>Members</h2><table>${members.map((m) => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td style="text-align:right">${m.role !== 'owner' ? `<button class="btn danger small delMember" data-id="${m.id}">Remove</button>` : ''}</td></tr>`).join('')}</table>
          <form id="mf" class="row" style="margin-top:10px"><input name="email" placeholder="teammate@4aro.com" style="flex:2" required><select name="role" style="flex:1"><option>developer</option><option>admin</option><option>viewer</option></select><button class="btn secondary" type="submit">Add</button></form></div>
        ${hooks ? `<div class="card"><h2>Webhooks</h2>${hooks.webhooks.map((h) => `<div class="row" style="justify-content:space-between"><span class="mono small">${esc(h.url)}</span><button class="btn danger small delHook" data-id="${h.id}">Delete</button></div>`).join('') || '<div class="muted small">None</div>'}
          <form id="hf" class="row" style="margin-top:10px"><input name="url" placeholder="https://hooks.slack.com/..." required style="flex:1"><button class="btn secondary" type="submit">Add</button></form>
          <p class="small muted">Signed with HMAC-SHA256 in <code>x-launchdock-signature</code>. Events: ${hooks.events.join(', ')}.</p></div>` : ''}
        ${p.role === 'owner' ? `<div class="card"><h2>Danger zone</h2><button class="btn danger" id="delProject">Delete project</button></div>` : ''}
      </div></div>`,
    bind() {
      onSubmit('#pf', async (_f, d) => {
        if (!d.gitToken) delete d.gitToken;
        await PATCH(`/api/projects/${p.id}`, d);
        toast('Saved');
        route();
      });
      onSubmit('#vf', async (_f, d) => {
        await PUT(`/api/projects/${p.id}/versions/ios`, { buildNumber: Number(d.ios) });
        await PUT(`/api/projects/${p.id}/versions/android`, { buildNumber: Number(d.android) });
        toast('Build numbers updated');
      });
      onSubmit('#mf', async (_f, d) => {
        await POST(`/api/projects/${p.id}/members`, d);
        route();
      });
      on('.delMember', 'click', async (_e, el) => {
        await DEL(`/api/projects/${p.id}/members/${el.dataset.id}`);
        route();
      });
      onSubmit('#hf', async (_f, d) => {
        const { webhook } = await POST(`/api/projects/${p.id}/webhooks`, { url: d.url, events: [] });
        prompt('Webhook signing secret (shown once):', webhook.secret);
        route();
      });
      on('.delHook', 'click', async (_e, el) => {
        await DEL(`/api/projects/${p.id}/webhooks/${el.dataset.id}`);
        route();
      });
      on('#delProject', 'click', async () => {
        if (prompt(`Type the project name to delete it: ${p.name}`) !== p.name) return;
        await DEL(`/api/projects/${p.id}`);
        location.hash = '#/';
      });
    },
  };
}

function renderLogLine(l) {
  const t = esc(l.line);
  if (l.line.startsWith('━━━')) return `<div class="sec">${t}</div>`;
  if (l.line.startsWith('$ ')) return `<div class="cmd">${t}</div>`;
  if (/^✖|error:|FAILURE|BUILD FAILED|\*\* ARCHIVE FAILED/i.test(l.line)) return `<div class="err">${t}</div>`;
  return `<div>${t}</div>`;
}

function streamLogs(kind, id, onStatus) {
  const box = document.getElementById('logs');
  let atBottom = true;
  box.addEventListener('scroll', () => (atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30));
  const es = new EventSource(`/api/${kind}/${id}/logs/stream?token=${encodeURIComponent(state.token)}`);
  es.addEventListener('log', (e) => {
    box.insertAdjacentHTML('beforeend', renderLogLine(JSON.parse(e.data)));
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
  let last;
  es.addEventListener('status', (e) => {
    const { status } = JSON.parse(e.data);
    if (last && status !== last) onStatus(status);
    last = status;
  });
  es.addEventListener('end', () => es.close());
  state.cleanup.push(() => es.close());
}

async function buildPage(id) {
  const { build: b, submissions } = await GET(`/api/builds/${id}`);
  const { project: p } = await GET(`/api/projects/${b.projectId}`);
  const active = ['queued', 'in_progress'].includes(b.status);
  mount(shell(`
    <div class="header"><div><div class="small muted"><a href="#/projects/${p.id}">${esc(p.name)}</a> / builds</div>
      <h1>${platformBadge(b.platform)} Build ${b.id.slice(0, 8)} ${badge(b.status)}</h1></div>
      <div class="row">
        ${active ? '<button class="btn danger" id="cancel">Cancel</button>' : '<button class="btn secondary" id="retry">Rebuild</button>'}
        ${b.hasArtifact ? `<button class="btn secondary" id="share">Share / install link</button><a class="btn secondary" id="dl" href="#">Download ${esc(b.artifactName?.split('.').pop() || '')}</a>` : ''}
        ${b.status === 'finished' ? '<button class="btn" id="submitBtn">Submit to store</button>' : ''}
      </div></div>
    <div class="grid cols-2" style="margin-bottom:16px">
      <div class="card kv">
        <div>Profile</div><div>${esc(b.profile)}</div>
        <div>Version</div><div class="mono">${esc(b.appVersion || '—')} (${esc(b.buildNumber || '—')})</div>
        <div>Runtime</div><div class="mono">${esc(b.runtimeVersion || '—')}</div>
        <div>Channel</div><div>${esc(b.channel || '—')}</div>
        <div>Source</div><div class="mono small">${b.sourceType === 'git' ? `git ${esc(b.gitRef)}` : 'upload'} ${b.gitCommit ? esc(b.gitCommit.slice(0, 10)) : ''}</div>
      </div>
      <div class="card kv">
        <div>Artifact</div><div class="mono small">${esc(b.artifactName || '—')} ${b.artifactSize ? `(${size(b.artifactSize)})` : ''}</div>
        <div>Worker</div><div class="mono small">${esc(b.workerId || '—')}</div>
        <div>Queued</div><div>${new Date(b.createdAt).toLocaleString()}</div>
        <div>Duration</div><div>${dur(b.startedAt, b.finishedAt)}</div>
        <div>Message</div><div>${esc(b.message || '—')}</div>
      </div>
    </div>
    ${b.error ? `<div class="card" style="border-color:#5a2a35;margin-bottom:16px"><b style="color:var(--red)">Error</b><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(b.error)}</pre></div>` : ''}
    <div id="submitForm" class="card hidden" style="margin-bottom:16px"><h2>Submit to ${b.platform === 'ios' ? 'App Store Connect' : 'Google Play'}</h2>
      <form id="sf" class="grid cols-3">${b.platform === 'android'
        ? `<div><label>Track</label><select name="track"><option>internal</option><option>alpha</option><option>beta</option><option>production</option></select></div>
           <div><label>Release status</label><select name="releaseStatus"><option>draft</option><option>completed</option><option value="inProgress">staged rollout</option></select></div>
           <div><label>Rollout fraction (staged)</label><input name="rollout" type="number" step="0.01" min="0" max="1" placeholder="0.1"></div>`
        : `<div><label>TestFlight groups (comma separated, optional)</label><input name="groups" placeholder="Internal Testers"></div>
           <div><label>What to test (optional)</label><input name="whatToTest"></div>`}
        <div class="actions"><button class="btn" type="submit">Queue submission</button></div></form></div>
    ${submissions.length ? `<div class="card" style="padding:0;margin-bottom:16px"><table><tr><th>Submission</th><th>Status</th><th>Result</th><th>Created</th></tr>
      ${submissions.map((s) => `<tr class="link" data-href="#/submissions/${s.id}"><td class="mono small">${s.id.slice(0, 8)}</td><td>${badge(s.status)}</td><td class="small mono">${esc(s.error || (s.result ? JSON.stringify(s.result) : ''))}</td><td class="small muted">${ago(s.createdAt)}</td></tr>`).join('')}</table></div>` : ''}
    <h3>Logs</h3><div class="logs mono" id="logs"></div>
  `, 'projects'));
  streamLogs('builds', id, () => route());
  on('tr.link', 'click', (_e, el) => (location.hash = el.dataset.href));
  on('#cancel', 'click', async () => (await POST(`/api/builds/${id}/cancel`), route()));
  on('#retry', 'click', async () => {
    const { build } = await POST(`/api/builds/${id}/retry`);
    location.hash = `#/builds/${build.id}`;
  });
  on('#dl', 'click', async (e) => {
    e.preventDefault();
    const { downloadUrl } = await POST(`/api/builds/${id}/share`, { ttlHours: 1 });
    location.href = downloadUrl;
  });
  on('#share', 'click', async () => {
    const { installUrl } = await POST(`/api/builds/${id}/share`, {});
    await navigator.clipboard?.writeText(installUrl).catch(() => {});
    prompt('Install link (valid 7 days, copied to clipboard):', installUrl);
  });
  on('#submitBtn', 'click', () => document.getElementById('submitForm').classList.toggle('hidden'));
  onSubmit('#sf', async (_f, d) => {
    const config = b.platform === 'android'
      ? { track: d.track, releaseStatus: d.releaseStatus, ...(d.rollout ? { rollout: Number(d.rollout) } : {}) }
      : { groups: d.groups ? d.groups.split(',').map((s) => s.trim()).filter(Boolean) : [], whatToTest: d.whatToTest || undefined };
    const { submission } = await POST(`/api/projects/${b.projectId}/submissions`, { buildId: b.id, config });
    location.hash = `#/submissions/${submission.id}`;
  });
}

async function submissionPage(id) {
  const { submission: s } = await GET(`/api/submissions/${id}`);
  mount(shell(`
    <div class="header"><div><div class="small muted"><a href="#/projects/${s.projectId}/submissions">Submissions</a> /</div>
      <h1>${platformBadge(s.platform)} Submission ${s.id.slice(0, 8)} ${badge(s.status)}</h1></div>
      <div class="row">${['queued', 'in_progress'].includes(s.status) ? '<button class="btn danger" id="cancel">Cancel</button>' : ''}</div></div>
    <div class="card kv" style="margin-bottom:16px">
      <div>Build</div><div><a href="#/builds/${s.buildId}" class="mono">${s.buildId.slice(0, 8)}</a></div>
      <div>Config</div><div class="mono small">${esc(JSON.stringify(s.config))}</div>
      <div>Result</div><div class="mono small">${esc(s.result ? JSON.stringify(s.result) : '—')}</div>
      <div>Error</div><div class="small" style="white-space:pre-wrap">${esc(s.error || '—')}</div>
    </div>
    <h3>Logs</h3><div class="logs mono" id="logs"></div>`, 'projects'));
  streamLogs('submissions', id, () => route());
  on('#cancel', 'click', async () => (await POST(`/api/submissions/${id}/cancel`), route()));
}

async function workersPage() {
  const [{ workers }, { queue }] = await Promise.all([GET('/api/workers'), GET('/api/queue')]);
  const q = (pl, st) => queue.find((x) => x.platform === pl && x.status === st)?.n || 0;
  mount(shell(`
    <div class="header"><div><h1>Build workers</h1><div class="muted">Linux workers build Android. macOS workers (with Xcode) build iOS.</div></div></div>
    <div class="grid cols-3" style="margin-bottom:16px">
      <div class="card"><h3>iOS queue</h3><div class="stat">${q('ios', 'queued')}</div><div class="small muted">${q('ios', 'in_progress')} running</div></div>
      <div class="card"><h3>Android queue</h3><div class="stat">${q('android', 'queued')}</div><div class="small muted">${q('android', 'in_progress')} running</div></div>
      <div class="card"><h3>Online workers</h3><div class="stat">${workers.filter((w) => w.online).length}</div></div>
    </div>
    ${workers.length ? `<div class="card" style="padding:0"><table><tr><th></th><th>Worker</th><th>Platforms</th><th>Toolchain</th><th>Current job</th><th>Last seen</th></tr>
      ${workers.map((w) => `<tr><td><span class="dot ${w.online ? 'on' : ''}"></span></td><td class="mono">${esc(w.id)}</td><td>${w.platforms.map(platformBadge).join(' ')}</td>
        <td class="small muted">${esc([w.info?.os, w.info?.xcode, w.info?.java].filter(Boolean).join(' · '))}</td>
        <td class="mono small">${w.currentJob ? `<a href="#/${w.currentJob.startsWith('build') ? 'builds' : 'submissions'}/${w.currentJob.split(':')[1]}">${esc(w.currentJob)}</a>` : '—'}</td>
        <td class="small muted">${ago(w.lastSeenAt)}</td></tr>`).join('')}</table></div>`
      : `<div class="card empty">No workers have connected yet. Start one with <code>docker compose up android-worker</code> or the macOS installer.</div>`}
  `, 'workers'));
}

async function accountPage() {
  const [{ tokens }, users] = await Promise.all([GET('/api/tokens'), state.user.isAdmin ? GET('/api/admin/users') : null]);
  mount(shell(`
    <div class="header"><div><h1>Account</h1><div class="muted">${esc(state.user.email)}</div></div></div>
    <div class="grid cols-2">
      <div class="card"><h2>API tokens</h2><p class="small muted">For the CLI and CI (<code>LAUNCHDOCK_TOKEN</code>). <code>launchdock login</code> creates one automatically.</p>
        ${tokens.length ? `<table>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td class="small muted">used ${ago(t.lastUsedAt)}</td><td style="text-align:right"><button class="btn danger small revoke" data-id="${t.id}">Revoke</button></td></tr>`).join('')}</table>` : ''}
        <form id="tf" class="row" style="margin-top:10px"><input name="name" placeholder="GitHub Actions" required style="flex:1"><button class="btn secondary" type="submit">Create token</button></form>
        <div id="newToken"></div></div>
      <div class="card"><h2>Change password</h2><form id="pw"><label>Current password</label><input type="password" name="currentPassword" required>
        <label>New password</label><input type="password" name="newPassword" minlength="8" required><div class="actions"><button class="btn secondary" type="submit">Update</button></div></form></div>
      ${users ? `<div class="card"><h2>Users</h2><table>${users.users.map((u) => `<tr><td>${esc(u.email)}</td><td class="small muted">${u.isAdmin ? 'admin' : ''}</td></tr>`).join('')}</table>
        <form id="uf" style="margin-top:10px"><label>Email</label><input name="email" type="email" required><label>Temporary password</label><input name="password" type="text" minlength="8" required>
        <label><input type="checkbox" name="isAdmin" style="width:auto"> Admin</label><div class="actions"><button class="btn secondary" type="submit">Invite user</button></div></form></div>` : ''}
    </div>`, 'account'));
  onSubmit('#tf', async (_f, d) => {
    const t = await POST('/api/tokens', d);
    document.getElementById('newToken').innerHTML = `<p class="small">Copy now — it won't be shown again:</p><div class="secret-box mono small">${esc(t.token)}</div>`;
  });
  on('.revoke', 'click', async (_e, el) => (await DEL(`/api/tokens/${el.dataset.id}`), route()));
  onSubmit('#pw', async (_f, d) => (await POST('/api/me/password', d), toast('Password updated')));
  onSubmit('#uf', async (_f, d) => (await POST('/api/admin/users', { ...d, isAdmin: d.isAdmin === 'on' }), toast('User created'), route()));
}

// ---------- router ----------
async function route() {
  state.cleanup.splice(0).forEach((fn) => fn());
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  try {
    if (parts[0] === 'login') return await loginPage();
    if (!state.token) return (location.hash = '#/login');
    if (!state.user) state.user = (await GET('/api/me')).user;
    if (!parts.length) return await projectsPage();
    if (parts[0] === 'projects' && parts[1]) return await projectPage(parts[1], parts[2] || 'builds');
    if (parts[0] === 'builds' && parts[1]) return await buildPage(parts[1]);
    if (parts[0] === 'submissions' && parts[1]) return await submissionPage(parts[1]);
    if (parts[0] === 'workers') return await workersPage();
    if (parts[0] === 'account') return await accountPage();
    mount(shell('<div class="card empty">Page not found</div>'));
  } catch (err) {
    if (state.token) mount(shell(`<div class="card empty">${esc(err.message)}</div>`));
    toast(err.message, true);
  }
}

window.addEventListener('hashchange', route);
route();
