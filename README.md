<img src="assets/icon.svg" width="64" height="64" alt="">

# feedback-toolbar

An open-source website feedback toolbar for people and their coding agents. Select an element, start a thread, reply or react, and send an explicit work request to a local agent. Results return to the thread for human review.

The embed works with any framework. A small JavaScript loader mounts a separate-origin iframe inside a closed shadow root. Tailwind, shadcn components, and Base UI render inside that iframe, independently of the website's styles and authentication.

## Install on a website

Create an account in your feedback service, create a project, and register the website's exact origins. Copy the script from **Installation** into the website's shared HTML layout:

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

Add `data-feedback-id="hero-cta"` to important elements to keep anchors stable across deployments. The selector, bounded element text, viewport, URL, and deployment reference accompany the comment. The loader excludes form values and elements marked `data-feedback-private`; the service strips URL queries and fragments.

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

This adapter requires Codex CLI 0.161.0 or newer and an existing harness login. It ignores user configuration and execution rules, enforces a workspace permission profile, denies secret files and unrelated filesystem reads, disables command networking, and supplies a minimal tool environment. It never auto-merges or deploys. Use WSL on Windows. Prepare dependencies before starting; network-dependent checks must be run separately by a trusted operator.

Claims are exclusive per project and tied to a leased credential. Revocation, cancellation, or lease expiry stops further authorized updates. A crashed or ambiguous run requires review before retrying. Agent completion leaves the feedback thread open for human review.

## Appearance

Project owners configure light, dark, or system mode; accent color; corner radius; density; and toolbar placement. The same tokens apply to the toolbar and its dialogs. Validated overrides are also available in `mountFeedback({ theme: ... })` or script attributes such as `data-accent`, `data-mode`, and `data-placement`.

## Development and self-hosting

```sh
bun run dev
```

Open `http://localhost:4310` for the dashboard and `http://localhost:4311` for the separate example website. The dashboard walks through project creation, installation, and toolbar sign-in. SQLite data lives in the ignored `.data/` directory. The self-hosted Node service uses the same authorization and storage interfaces as production.

```sh
bun run check
bun audit --audit-level=high
```

Checks include formatting, strict typed ESLint, TypeScript, Knip, authorization/concurrency tests, a real local Workers/D1 integration, Chromium browser flows, and a Worker bundle check. Browser tests exercise independent toolbar authorization, element selection, reactions, work requests, result delivery, theming, and host-style isolation.

## Production deployment

Vercel serves built browser assets and proxies dynamic paths to a Cloudflare Worker. D1 stores accounts, memberships, hashed credentials, threads, work requests, persistent rate limits, and audit events. The example website runs on the Worker origin, separately from the toolbar UI.

GitHub Actions deploys only a protected `main` commit after **Required checks** passes. The pipeline applies D1 migrations, deploys the API Worker, uploads the tested static assets through Vercel's deployment API, and checks production health. Vercel Git auto-deployments are disabled. No deploy credentials are supplied to PR tests.

Repository secrets:

| Secret                 | Scope                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts Edit, Workers Tail Read, and D1 Edit on the deployment account |
| `VERCEL_TOKEN`         | The deployment project or team                                                 |

Repository variables are `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `FEEDBACK_URL`, and `FEEDBACK_API_ORIGIN`. Forks must also update the account, database, origins, and names in `wrangler.jsonc` before provisioning their own infrastructure. Public resource IDs in configuration are identifiers, not credentials.

PR protection requires an up-to-date branch, code-owner review, approval after the last push, resolved conversations, and passing checks. The required gate includes dependency review, dependency audit, CodeQL, and a checksum-pinned Gitleaks history scan. Dependency updates run through Dependabot. Deployment tokens should expire and be rotated.

## Security boundaries

Toolbar access uses its own account and an approved, single-use PKCE exchange. Browser sessions use HttpOnly cookies; embeds receive expiring project- and origin-scoped credentials. The host page never receives the iframe's bearer token. The server checks membership, role, credential scope, and registered origins on every operation. Messages are rendered as text, and theme input is validated.

Style isolation protects rendering, not secrets from a malicious website or browser extension. Do not place private credentials in selected text. Human review remains necessary before applying agent changes. The executable adapter is a separate process using the harness's OS sandbox; it is not a separate virtual machine.

Accounts currently use email/password authentication without email verification, password recovery, or SSO. Treat email addresses as unverified labels when adding members. This release needs a security review before unrestricted public signup or use with sensitive feedback. To disable signup, set `FEEDBACK_ALLOW_SIGNUP=false` after creating the required accounts.

MIT licensed. Contributions should go through pull requests.
