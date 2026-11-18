// Optional: start an on-demand macOS (or Linux) worker on GitHub Actions when jobs are queued.
// Set GITHUB_DISPATCH_REPO=owner/repo, GITHUB_DISPATCH_TOKEN (fine-grained PAT with Actions: write),
// GITHUB_DISPATCH_WORKFLOW=launchdock-worker.yml, GITHUB_DISPATCH_PLATFORMS=ios (comma list).
const repo = process.env.GITHUB_DISPATCH_REPO;
const token = process.env.GITHUB_DISPATCH_TOKEN;
const workflow = process.env.GITHUB_DISPATCH_WORKFLOW || 'launchdock-worker.yml';
const ref = process.env.GITHUB_DISPATCH_REF || 'main';
const platforms = (process.env.GITHUB_DISPATCH_PLATFORMS || 'ios').split(',').map((s) => s.trim());

const lastDispatch = {};

export async function dispatchRunner(platform) {
  if (!repo || !token || !platforms.includes(platform)) return;
  // Debounce: one runner start per platform every 20s; the runner drains the whole queue.
  if (Date.now() - (lastDispatch[platform] || 0) < 20000) return;
  lastDispatch[platform] = Date.now();
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ ref, inputs: { platform } }),
    });
    if (!res.ok) console.warn(`[dispatch] GitHub returned ${res.status}: ${await res.text()}`);
    else console.log(`[dispatch] Started GitHub Actions ${platform} worker`);
  } catch (err) {
    console.warn(`[dispatch] ${err.message}`);
  }
}
