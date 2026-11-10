# Setup

Happy runs on your own Mac with your own logins. Install it first (see the [README](../README.md)), then set up the parts you want. Every section except Settings is optional.

## Settings

Open Settings with the gear at the top of the sidebar.

1. **You:** your name, role, sign-off, and any rules for how email drafts should sound (one per line). Your email fills in from Gmail once you connect it.
2. **Main repo:** the full path to the repo you work in most. New chats, task agents and Cloud fixes start here, and the Manager board and Stats read it.
3. **Defaults:** the agent (Claude, Codex or Cursor) and model for new chats.
4. **Max permissions:** whether chats in each area (chats, tasks, Manager, Cloud, Mail) run without asking. Sending an email always asks.
5. **Sidebar:** hide the sections you won't use.

## Project config (deploys and Cloud)

Describe your environments, deploy tags and commands in a project config. See [project-config.md](project-config.md). Without one, the Manager board still shows chats, unmerged work and commits that landed on main.

## Mail and Calendar (Google)

Happy signs in to Google with an OAuth client that you create. Google doesn't charge for it.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project or pick an existing one.
2. Under **APIs & Services → Library**, enable the **Gmail API**, **Google Calendar API** and **People API**.
3. Under **Google Auth Platform → Branding**, set up the consent screen.
   - With Google Workspace you can pick **Internal**, which lets anyone in your organization use the client.
   - Otherwise pick **External**, leave it in Testing and add yourself under **Audience → Test users**.
4. Under **Clients → Create client**, choose **Desktop app**. Copy the **Client ID** and **Client secret**.
5. In Happy, open Mail, paste both, save, then press **sign in with Google**. Calendar uses the same sign-in.

Happy asks for these scopes:
- Gmail modify, to read, archive, star, label and draft
- Gmail basic settings, for the "always archive this sender" filters
- Calendar events
- read-only contacts, other contacts and directory, for names and autocomplete

The tokens are encrypted with your macOS keychain and never leave your Mac.

## Tasks (Linear)

In Linear, go to **Settings → Security & access → Personal API keys** and create a key. Paste it into Tasks in Happy. A read-only key works for browsing; editing and creating issues need write access.

## Cloud (Google Cloud)

1. Install the CLI: `brew install --cask google-cloud-sdk`.
2. Turn the page on with `"cloud": { "provider": "gcp" }` in your project config, and give each environment a cloud project. You can name it with `cloudProject`, or let Happy read `PROJECT_ID` from the environment's `envFile`.
3. Open Cloud and press **sign in to gcloud**. The sign-in opens in Chrome, or in your default browser if Chrome isn't installed.
4. Click the **gcloud** chip in the top bar and make sure both "gcloud CLI login" and "application default" say valid.

You need read access to each project. The Cloud chat only changes resources when you ask, and it tells you the exact command first.

## Phone (Tailscale)

Tailscale puts your Mac and phone on a private network, so you can reach Happy from anywhere without exposing it to the internet. The free Personal plan is enough.

1. Install Tailscale on the Mac and on your phone, and sign in to both with the same account.
2. In Happy on the Mac, go to **Settings → Phone access** and turn it on. It shows an address (`https://<your-mac>.<tailnet>.ts.net`) and a pairing code. If it asks you to enable HTTPS certificates or Serve in Tailscale, follow its link once.
3. On the phone, open the address in Safari and enter the code. Then tap **Share → Add to Home Screen**.
4. In Happy on the phone, go to **Settings → This phone** and turn on notifications to get a push when an agent needs you.

Leave **Keep this Mac awake** on if you want to reach it with the lid closed on power.

## Updating

**Settings → App → Update & restart** rebuilds Happy from the folder you cloned and reopens it, which takes about a minute. If the checkout tracks a remote and has no local changes, it pulls first. Chats that are mid-turn stop; send "continue" once Happy is back.

## Troubleshooting

- **A chat says it isn't signed in:** run `claude`, `codex login` or `agent login` in a terminal, then send the message again.
- **`npm: command not found` while building:** open a new terminal window after installing Node.
- **The Cloud page is empty:** check that Settings → Main repo points at your repo, and that its project config has `cloud` and environments with cloud projects.
- **Google says "access blocked":** with an External client in Testing, add your account as a test user.
- **The phone page won't load:** Tailscale has to be on for both devices, and Happy has to be running on the Mac.
