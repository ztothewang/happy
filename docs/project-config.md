# Project config

Happy works on any git repo with no setup: chats, worktrees, merged/ahead state, Terminal, Stats.
For deploy tracking, the Cloud page and nicer chat titles, describe your project in a config file.

## Where it lives

Happy uses the first file it finds:

1. `.happy/config.json` in the checkout (a worktree can carry its own on a branch)
2. `.happy/config.json` in the repo's main checkout
3. Your own copy, kept outside the repo: `~/Library/Application Support/session-hub/projects/<repo folder name>.json`

Commit option 1 or 2 to share it with your team. Use option 3 if you'd rather not commit anything.

## Example

```json
{
  "description": "Acme: a web app (api + web) on Cloud Run",
  "environments": [
    { "id": "prod", "name": "Production", "color": "#3b82f6", "tag": "", "envFile": "env.prod" },
    { "id": "eu", "name": "Europe", "tag": "eu", "envFile": "env.eu.prod" }
  ],
  "deploy": {
    "tagPrefix": "deployed",
    "components": [
      { "id": "api", "short": "api", "label": "API", "paths": ["api/"] },
      { "id": "web", "short": "web", "label": "Web", "paths": ["web/"] }
    ],
    "commands": {
      "api": "ENV_FILE={envFile} ./scripts/deploy-api.sh",
      "web": "ENV_FILE={envFile} ./scripts/deploy-web.sh",
      "core": "ENV_FILE={envFile} ./scripts/deploy-api.sh && ENV_FILE={envFile} ./scripts/deploy-web.sh",
      "full": "ENV_FILE={envFile} ./scripts/deploy.sh"
    }
  },
  "packages": [{ "dir": "sdk" }],
  "glossary": { "eu": "Europe" },
  "cloud": { "provider": "gcp" }
}
```

## Fields

Every field is optional.

### `environments`

The places you deploy to: tenants, regions, staging and production. Each one has:

| Field | Meaning |
|---|---|
| `id` | Short id shown on chips and the board (`prod`, `eu`). |
| `name` | Display name, used in titles, prompts and the Cloud page. |
| `color` | Chip and chart color. When missing, Happy picks one from a fixed palette. |
| `tag` | The environment's part of a deploy tag (see below). `""` means tags with no environment part. Defaults to `id`. |
| `aliases` | Other tag parts that mean the same environment. |
| `envFile` | Env file in the repo. Fills `{envFile}` in commands. The Cloud page reads `PROJECT_ID`, `REGION` and `FIREBASE_PROJECT_ID` from it, and nothing else. |
| `cloudProject`, `region`, `firebaseProject` | Set these directly instead of reading them from `envFile`. |
| `commands` | Per-environment overrides of `deploy.commands`. |

### `deploy`

Happy tracks deploys through git tags that your deploy scripts push:

```
<tagPrefix>-[<environment tag>-]<component | full>-<YYYYMMDD-HHMMSS>-<sha>
deployed-api-20261108-142233-3f9c2ab        # api to the default environment
deployed-eu-full-20261108-150102-3f9c2ab    # everything to eu
```

| Field | Meaning |
|---|---|
| `tagPrefix` | Defaults to `deployed`. |
| `components` | The parts you deploy separately. Each has an `id`, an optional `short` label for chips, a `label`, and the `paths` (git pathspecs) whose changes it ships. A branch counts as deployed only for the components it changed. |
| `fullIgnore` | Paths a full deploy ignores when counting what's behind. Defaults to `docs` and `*.md`. |
| `commands` | What the Manager board's deploy menu runs in a Terminal shell. One per component id, plus `core` (every component) and `full`. Placeholders: `{env}`, `{envFile}` and `{tag}`. |

A `full` deploy counts as a deploy of every component.

### `packages`

npm packages published from folders in the repo (`{ "dir": "sdk" }`). The board compares the version on main with the version on npm, and flags changes made since the last version bump.

### `glossary`

Short codes that chat titles should spell out (`"eu": "Europe"`). Environment names are added automatically.

### `cloud`

`{ "provider": "gcp" }` turns on the Cloud page, which reads Cloud Run, Cloud SQL, Scheduler, Tasks and Logging through `gcloud`. It shows each environment whose cloud project Happy can find. GCP is the only provider so far.
