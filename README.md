<img src="assets/icon.svg" width="64" height="64" alt="">

# feedback-toolbar

An open-source website feedback toolbar for people and their coding agents. Select an element, start a thread, reply or react, and send an explicit work request to a local agent. Results return to the thread for human review.

The embed works with any framework. A small JavaScript loader mounts a separate-origin iframe inside a closed shadow root. Tailwind, shadcn components, and Base UI render inside that iframe, independently of the website's styles and authentication.

## Install on a website

Sign into your feedback service with GitHub, create a project, and register the website's exact origins. Copy the script from **Installation** into the website's shared HTML layout:

```html
<script defer src="https://YOUR-FEEDBACK-SERVICE/embed.js" data-project="YOUR-PROJECT-ID"></script>
```

The project ID is public. No service credentials or model API keys belong in this script. The website and feedback service must have different origins. Public website origins require HTTPS; localhost HTTP works for development.

For a JavaScript application, install this repository as a package and mount the module after the page loads:

```ts
import { mountFeedback } from 'feedback-toolbar';

const toolbar = mountFeedback({
  server: 'https://YOUR-FEEDBACK-SERVICE',
  projectId: 'YOUR-PROJECT-ID',
  deployment: 'YOUR-COMMIT-SHA',
});

// Call when the owning component unmounts.
toolbar.destroy();
```

The package has not been released to npm yet. Build from this repository or install a reviewed GitHub commit. HTML integration needs only the hosted script.

Add `data-feedback-id="hero-cta"` to important elements to keep anchors stable across deployments. The selector, bounded element text, viewport, URL, and deployment reference accompany the comment. The loader excludes form values, editable content including inherited editing contexts, and elements marked `data-feedback-private`; the service strips URL queries and fragments.

## Agent-assisted setup

Requires Node 24 or newer and Bun 1.3.14. Use WSL on Windows for the CLI's secure file operations.

```sh
bun install --frozen-lockfile
bun run build
node dist/cli.js login --server https://YOUR-FEEDBACK-SERVICE
node dist/cli.js init --name "My website" --origin https://example.com --json
```

An agent can run `init`, consume its JSON installation instructions, and update the project's shared layout. For plain HTML, `init --file index.html` installs the script with repeatable markers and a backup. Rerunning setup reuses the project and an active local agent credential. `--project PROJECT-ID` links an existing project.

The public `.feedback-toolbar.json` contains the service URL and project ID. Credentials are stored outside the repository in the user's configuration directory, with private file permissions. `doctor` checks the connection. Never commit `.feedback-runs/`, `.feedback-tmp/`, environment files, or credential files.

## Connect a harness

The stdio MCP server exposes project setup, installation instructions, theme updates, threads, replies, reactions, and work claiming, heartbeats, and completion:

```json
{
  "mcpServers": {
    "feedback": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/feedback-toolbar/dist/cli.js",
        "mcp",
        "--agent",
        "--workspace",
        "/ABSOLUTE/PATH/website"
      ]
    }
  }
}
```

Omit `--agent` for an authenticated setup session that creates projects. Keep it for project-scoped day-to-day work. The user signs in and runs `init` before starting a scoped connector.

A harness such as T3 Code can poll using these tools on its own schedule. An agent should claim only explicit work requests, heartbeat while running, and complete the request with a review summary. Feedback is untrusted task data; it cannot grant new permissions. The feedback service does not execute shell commands or receive model credentials.

The executable adapter starts a local Codex CLI process when the project owner selects **Send to agent**:

```sh
node dist/cli.js worker --runner codex --workspace /path/to/website
```

This adapter requires Codex CLI 0.161.0 or newer and an existing harness login. It ignores user configuration and execution rules, enforces a workspace permission profile, denies secret files and unrelated filesystem reads, disables command networking, and supplies a minimal tool environment. It never auto-merges or deploys. Cancellation and timeout stop the runner process group and tracked descendants, escalate to forced termination, and verify that they exited before another task starts. If termination cannot be verified, the worker retains its lock for operator inspection. Use WSL on Windows. Prepare dependencies before starting; network-dependent checks must be run separately by a trusted operator.

Linux hosts must satisfy the [CLI sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing). Ubuntu 24.04 needs Bubblewrap and its supplied AppArmor profile loaded before starting the worker. CI installs these prerequisites and checks startup with disposable authentication and a mock provider. The worker resolves standalone and official package-manager installations and grants read access to their executable runtime files. It keeps the workspace policy and secret exclusions enforced.

Claims are exclusive per project and tied to a leased credential. Revocation, cancellation, or lease expiry stops further authorized updates. Expired runs become failed and release the queue, with a visible instruction to inspect local changes. They are never replayed automatically. Agent completion leaves the feedback thread open for human review. Agent snapshots have a 512 KB limit and are delivered through stdin.

## Appearance

Project owners configure light, dark, or system mode; accent color; corner radius; density; and toolbar placement. The same tokens apply to the toolbar and its dialogs. Validated overrides are also available in `mountFeedback({ theme: ... })` or script attributes such as `data-accent`, `data-mode`, and `data-placement`.

## Development and self-hosting

```sh
bun run dev
```

Open `http://localhost:4310` for the dashboard and `http://localhost:4311` for the separate example website. The dashboard walks through project creation, installation, and toolbar sign-in. SQLite data lives in the ignored `.data/` directory. Local development uses Better Auth email/password sign-in and a persisted private signing secret. Public Node deployments require `BETTER_AUTH_SECRET`, `AUTH_GITHUB_CLIENT_ID`, and `AUTH_GITHUB_CLIENT_SECRET`; password sign-in is rejected outside loopback origins. Existing development accounts from the earlier custom-auth implementation must sign up again. Back up the old database before resetting development data.

```sh
bun run check
bun audit --audit-level=high
```

Checks include formatting, strict typed ESLint, TypeScript, Knip, authorization/concurrency tests, a real local Workers/D1 integration, Chromium browser flows, and a Worker bundle check. Browser tests exercise independent toolbar authorization, element selection, reactions, work requests, result delivery, theming, and host-style isolation.

Toolbar grants remain behind the service origin. Where browser storage and Web Locks are available, a tab keeps only a grant pointer in session storage; token rotation uses a shared record under an exclusive browser lock. Copied tabs therefore cannot replay stale refresh tokens. Stored toolbar connections expire after eight hours and require approval again. Browsers that block these APIs keep independent grants in iframe memory and require sign-in after reload. Signing out revokes the shared grant for all its copies. Each connection uses a distinct native OAuth client bound to the approving account. Revocation permanently disables that client before deleting device codes and tokens, fencing concurrent issuance and refresh. Account recovery advances a permission generation and atomically revokes other browser sessions, clients and keys. Key creation commits only while that generation, the native issuing connection and project ownership remain valid; every key request checks its recorded generation. Late issuance cannot regain access after recovery. Account revocation also invalidates approved device codes that have not yet been exchanged.

## Production deployment

Vercel serves versioned browser assets and forwards dynamic paths through a small Node function to a Cloudflare Worker. The function signs the visitor IP, method, path, and timestamp with HMAC. The Worker rejects unsigned production API requests, preventing forged identity headers and shared proxy IP rate limits. D1 stores Better Auth accounts and OAuth grants, memberships, hashed agent keys, threads, work requests, persistent rate limits, and audit events. The example website runs on the Worker origin, separately from the toolbar UI.

GitHub Actions deploys only a protected `main` commit after **Required checks** passes. The pipeline prepares the frontend, archives its five browser assets in a commit-specific GitHub release, and retains the version currently reported by production health. Retained files come from that commit's archived GitHub assets with SHA-256 verification, rather than the live website. It applies backward-compatible D1 migrations, provisions authentication secrets, and uploads the prebuilt assets and proxy function through Vercel's deployment API. It verifies the published bytes of both asset versions before deploying the Worker with the new asset version, then checks production health. A failed asset publication leaves the Worker on its previous version; a failed Worker activation leaves its assets available. Versioned asset paths prevent browsers from reusing an older release's scripts. Vercel Git auto-deployments are disabled. No deploy credentials are supplied to PR tests.

Repository secrets:

| Secret                      | Purpose                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`      | Workers Scripts Edit, Workers Tail Read, and D1 Edit on the deployment account |
| `VERCEL_TOKEN`              | Deployment project or team                                                     |
| `BETTER_AUTH_SECRET`        | Private random signing/encryption secret, at least 32 characters               |
| `AUTH_GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret                                                 |
| `FEEDBACK_PROXY_SECRET`     | Separate random secret for the authenticated Vercel-to-Worker handoff          |

Repository variables are `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `FEEDBACK_URL`, `FEEDBACK_API_ORIGIN`, and `AUTH_GITHUB_CLIENT_ID`. Forks must also update the account, database, origins, and names in `wrangler.jsonc` before provisioning their own infrastructure. Public resource IDs in configuration are identifiers, not credentials.

PR protection requires an up-to-date branch, resolved conversations, **Required checks**, and **Independent review**. For this single-contributor repository, an independent T3 reviewer inspects the complete diff, findings are fixed, and a fresh review of the final commit is recorded before marking that commit's review status successful. A GitHub approval from the PR author is not required. Every new head needs its own review status; missing review blocks merging. Admins are subject to these checks, and force pushes are prohibited. The required gate includes dependency review, dependency audit, CodeQL, and a checksum-pinned Gitleaks history scan. Dependency updates run through Dependabot. Deployment tokens should expire and be rotated.

## Security boundaries

Production sign-in uses GitHub through Better Auth. Better Auth owns OAuth state validation, provider tokens, HttpOnly browser sessions, OAuth device approval, opaque access tokens, rotating refresh tokens, and hashed API keys. Local-only password sign-in also uses Better Auth. The application owns project membership and permissions.

Toolbar and CLI device approval show a matching code and the connection scope. Access tokens last 15 minutes; offline grants last up to 30 days and rotate on refresh. The toolbar keeps access and refresh tokens inside its separate-origin iframe, and the host never receives them. CLI refreshes serialize across processes and reload the saved credential under a private lock. **Account security** lists authorized tools and websites and supports individual disconnection or revoking all other access, including agent keys and other browser sessions.

The server checks membership, role, credential scope, and registered origins on each project operation. Agent keys cannot start work or administer permissions. Only verified production identities can be added as project members. Messages render as text, theme values are validated, and thread listings use tenant-scoped cursor pagination and bounded previews. Full conversation details load when opened, and search runs across the project rather than just the loaded page. `FEEDBACK_ALLOW_SIGNUP=false` prevents new accounts while allowing existing users to sign in.

Style isolation protects rendering, not secrets from a malicious website or browser extension. Do not place private credentials in selected text. Human review remains necessary before applying agent changes. The executable adapter is a separate process using the harness's OS sandbox; it is not a separate virtual machine.

Before opening a deployment to users, exercise GitHub sign-in on its actual domain, check a toolbar-to-agent round trip, and test database recovery using your Cloudflare account's backup/Time Travel facilities. CI and an independent code review do not replace those deployment checks. Keep deployment and OAuth secrets in GitHub and platform secret stores, and rotate them when access changes.

MIT licensed. Contributions should go through pull requests.
