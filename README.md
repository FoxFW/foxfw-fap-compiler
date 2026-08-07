# FoxFW FAP Compiler — workflow repo

This repo is what powers the "Compile .FAP" button on the FoxFW FAP
Compiler page (`fap-compiler.html` in the `fox-web` repo). It contains a
single GitHub Actions workflow (`compile.yml`) plus a small Cloudflare
Worker (`worker/`).

**Visitors never see a GitHub login prompt.** A Cloudflare Worker holds one
FoxFW-owned GitHub token server-side and triggers `compile.yml` on this repo
directly — no per-user fork, no pasted token. The browser only ever talks to
the Worker.

## One-time setup (you, the FoxFW maintainer)

1. This repo already exists at `github.com/FoxFW/foxfw-fap-compiler` with
   `compile.yml` in place — nothing to do here beyond keeping it public.
2. Deploy the Worker — see `worker/index.js` for full step-by-step
   instructions (Cloudflare dashboard only, no CLI required). In short:
   create a Worker, paste in `worker/index.js`, add a `GITHUB_PAT` secret
   (a classic PAT with `repo` + `workflow` scopes, belonging to an account
   with write access to this repo), and optionally bind a KV namespace
   named `RATE_LIMIT` for per-visitor cooldowns.
3. Open `fap-compiler.html` (in the `fox-web` repo) and set `WORKER_URL`
   near the top of the `<script>` block to your deployed Worker's URL.

That's it — the workflow always pulls the real firmware fresh from
`foxfw/2.0` at `master` on every run (see the `FOXFW_REPO` / `FOXFW_REF` env
vars in `compile.yml`), so you don't need to touch this repo again unless
the build steps themselves change.

## What a visitor does (handled entirely by the page + Worker)

1. Paste a GitHub repo URL for the Flipper app they want.
2. Click **Compile .FAP**. The page calls the Worker, which dispatches
   `compile.yml` on this repo using FoxFW's own token, and the page polls
   the Worker for live status until the build finishes.
3. The Worker downloads the resulting build artifact, unzips it server-side,
   and streams the raw `.fap` back — the page offers it as a direct
   download. No account, no token, no fork.

## The trade-off of not requiring login

Every visitor's build now runs under FoxFW's own GitHub account/Actions
minutes and this one shared repo, instead of each user's own fork. That's
the whole point (no login friction) — but it also means:

- Arbitrary GitHub repos get to run code (via `fbt`/build scripts) using
  FoxFW's Actions minutes. Public repos get free Actions minutes, so cost
  isn't the concern — abuse/resource exhaustion is.
- The Worker has a basic per-IP cooldown (`COOLDOWN_SECONDS`, needs the
  `RATE_LIMIT` KV binding) as a first line of defense. Consider adding a
  Cloudflare Turnstile challenge in front of `/compile` if this sees real
  traffic and gets abused.
- Keep an eye on the Actions tab periodically for anything unexpected.

## Notes / limitations

- Builds take a few minutes (fresh firmware checkout + toolchain download
  each time) — see "Switching to the fast path" below to speed this up.
- Multi-app repos (more than one `application.fam`) need the `subdir` input,
  which the page exposes as an "advanced" field.

## Switching to the fast (ufbt) path

FoxFW2.0 ships `.github/workflows/publish-sdk-index.yml`, which builds a
`flipper-z-f7-sdk-*.zip` bundle (same format the official firmware
publishes), attaches it to a GitHub Release, and publishes `directory.json`
to the `fox-web` repo — a ufbt-compatible SDK index served free via GitHub
Pages at `https://foxfw.github.io/fox-web/directory.json`.

Once you've run that workflow at least once (Actions tab on the FoxFW2.0
repo → "Publish SDK Index" → Run workflow) and confirmed the index is live:

```
curl -sf https://foxfw.github.io/fox-web/directory.json | python3 -m json.tool | head -30
```

...you can swap this repo's `compile.yml` for the much faster ufbt-based
one:

```
mv .github/workflows/compile-fast.yml.example .github/workflows/compile.yml
```

It builds in under a couple of minutes (no toolchain download, no full
firmware checkout) instead of 5-10+. Nothing on the `fap-compiler.html` or
Worker side needs to change — same inputs, same artifact naming.

Keep publishing a new SDK index (tag a release, or run the workflow
manually) whenever FoxFW2.0's firmware API changes, or apps built against a
stale SDK may not run correctly.
