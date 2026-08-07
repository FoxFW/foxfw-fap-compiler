// FoxFW FAP Compiler — Cloudflare Worker
//
// Holds a GitHub PAT server-side so visitors to fap-compiler.html never see
// a GitHub login prompt or need to paste a token. All GitHub API calls
// happen here; the browser only ever talks to this Worker.
//
// ── Deploy (no CLI needed) ──────────────────────────────────────────────
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Name it (e.g. foxfw-fap-compiler), deploy the default "Hello World"
//   3. Edit code -> replace everything with this file -> Save and deploy
//   4. Settings -> Variables and Secrets -> Add secret:
//        name: GITHUB_PAT
//        value: a GitHub PAT (classic, scopes: repo + workflow) belonging
//               to an account with write access to FoxFW/foxfw-fap-compiler
//   5. (Recommended) Settings -> Bindings -> KV Namespace -> create one
//      named RATE_LIMIT and bind it under the variable name RATE_LIMIT.
//      Without this, /compile has no per-visitor cooldown.
//   6. Copy the Worker's URL (https://<name>.<your-subdomain>.workers.dev)
//      into fap-compiler.html's WORKER_URL constant.
//
// ── Why this exists ──────────────────────────────────────────────────────
// Triggering a GitHub Actions run always requires a token with write access
// to the target repo — there's no anonymous way to do it. The old design
// asked each visitor to fork this repo and paste their own token. This
// Worker removes that step by using ONE token (yours) for every visitor,
// the same way other public "paste a repo, get a .fap" compilers work.
// Trade-off: every compile now runs under this repo/account, so arbitrary
// GitHub repos get to run code using your Actions minutes. The workflow
// timeout and the optional rate limit below are the main guardrails —
// keep an eye on the Actions tab if this gets heavy traffic.

const REPO_OWNER = 'FoxFW';
const REPO_NAME = 'foxfw-fap-compiler';
const WORKFLOW_FILE = 'compile.yml';
const DEFAULT_BRANCH = 'main';
const ALLOWED_ORIGIN = 'https://foxfw.github.io';
const COOLDOWN_SECONDS = 90; // per-IP, only applies to POST /compile

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function gh(env, path, opts = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  return fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `token ${env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'foxfw-fap-compiler-worker',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === '/compile' && request.method === 'POST') return await handleCompile(request, env);
      if (url.pathname === '/runs' && request.method === 'GET') return await handleRuns(env);
      if (url.pathname === '/jobs' && request.method === 'GET') return await handleJobs(url, env);
      if (url.pathname === '/artifact' && request.method === 'GET') return await handleArtifact(url, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

async function handleCompile(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.RATE_LIMIT) {
    const key = `cooldown:${ip}`;
    if (await env.RATE_LIMIT.get(key)) {
      return json({ error: `Please wait a bit before compiling again (~${COOLDOWN_SECONDS}s between compiles).` }, 429);
    }
    await env.RATE_LIMIT.put(key, '1', { expirationTtl: COOLDOWN_SECONDS });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const repoUrl = (body.repoUrl || '').trim();
  if (!repoUrl) return json({ error: 'repoUrl is required' }, 400);
  if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(repoUrl)) {
    return json({ error: 'That does not look like a github.com repo URL' }, 400);
  }

  const dispatchedAt = new Date().toISOString();
  const res = await gh(env, `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    body: {
      ref: DEFAULT_BRANCH,
      inputs: {
        repo_url: repoUrl,
        ref: (body.ref || '').trim(),
        subdir: (body.subdir || '').trim(),
      },
    },
  });

  if (!res.ok) {
    return json({ error: `GitHub dispatch failed: ${res.status} ${await res.text()}` }, 502);
  }
  return json({ ok: true, dispatchedAt });
}

async function handleRuns(env) {
  const res = await gh(env, `/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs?event=workflow_dispatch&per_page=10`);
  if (!res.ok) return json({ error: `GitHub error ${res.status}` }, 502);
  const data = await res.json();
  const runs = (data.workflow_runs || []).map((r) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    html_url: r.html_url,
    created_at: r.created_at,
  }));
  return json({ runs });
}

async function handleJobs(url, env) {
  const runId = url.searchParams.get('run_id');
  if (!runId) return json({ error: 'run_id is required' }, 400);
  const res = await gh(env, `/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/jobs`);
  if (!res.ok) return json({ error: `GitHub error ${res.status}` }, 502);
  const data = await res.json();
  const job = (data.jobs || [])[0];
  const steps = job ? job.steps.map((s) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })) : [];
  return json({ steps });
}

async function handleArtifact(url, env) {
  const runId = url.searchParams.get('run_id');
  if (!runId) return json({ error: 'run_id is required' }, 400);

  const listRes = await gh(env, `/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}/artifacts`);
  if (!listRes.ok) return json({ error: `GitHub error ${listRes.status}` }, 502);
  const list = await listRes.json();
  const artifact = (list.artifacts || [])[0];
  if (!artifact) return json({ error: 'No artifact found for this run' }, 404);

  const zipRes = await gh(env, artifact.archive_download_url);
  if (!zipRes.ok) return json({ error: `Failed to download artifact: ${zipRes.status}` }, 502);
  const zipBuf = new Uint8Array(await zipRes.arrayBuffer());

  const file = await unzipFirstFap(zipBuf);
  if (!file) return json({ error: 'No .fap file found inside the build artifact' }, 500);

  return new Response(file.data, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file.name}"`,
      ...corsHeaders(),
    },
  });
}

// Minimal ZIP reader (End-Of-Central-Directory based, so it works
// regardless of whether GitHub streamed the entry) + the platform's native
// DecompressionStream for inflate — no dependencies needed.
async function unzipFirstFap(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65557; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(cdOffset + 46, cdOffset + 46 + nameLen));

    if (name.toLowerCase().endsWith('.fap')) {
      const lfNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lfExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lfNameLen + lfExtraLen;
      const compData = bytes.slice(dataStart, dataStart + compSize);
      const data = method === 0 ? compData : await inflateRaw(compData);
      return { name: name.split('/').pop(), data };
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function inflateRaw(compData) {
  const stream = new Blob([compData]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
