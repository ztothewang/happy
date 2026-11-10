import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Contact } from "../shared/types.js";
import type { Gmail } from "./gmail.js";

const RANK: Record<Contact["source"], number> = { directory: 0, contacts: 1, other: 2, mail: 3 };

/**
 * Names for email addresses, for display and autocomplete: your Google Workspace directory, your Google contacts, Google's
 * "other contacts" (people you've emailed), and names seen in mail headers. Cached to disk; refreshed every 6 hours.
 */
export class ContactBook {
  private map = new Map<string, Contact>();
  private file: string;
  private loadedAt = 0;
  private busy?: Promise<void>;

  constructor(dataDir: string, private google: Gmail) {
    this.file = join(dataDir, "contacts.json");
    try {
      if (existsSync(this.file)) for (const c of JSON.parse(readFileSync(this.file, "utf8")) as Contact[]) this.map.set(c.email, c);
    } catch {}
    google.onAddress = (name, email) => this.add({ name, email, source: "mail" });
  }

  private add(c: Contact) {
    const email = c.email.trim().toLowerCase();
    const name = c.name.trim().replace(/^"|"$/g, "");
    if (!email.includes("@") || !name || name.toLowerCase() === email) return;
    const prev = this.map.get(email);
    if (!prev || RANK[c.source] <= RANK[prev.source]) this.map.set(email, { email, name, source: c.source });
  }

  private async pages(url: (token?: string) => string, key: string, source: Contact["source"]) {
    let token: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await this.google.google(url(token), {}, "Contacts");
      for (const p of r[key] ?? []) {
        const name = p.names?.[0]?.displayName;
        for (const e of p.emailAddresses ?? []) if (name && e.value) this.add({ name, email: e.value, source });
      }
      token = r.nextPageToken;
      if (!token) break;
    }
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.loadedAt < 6 * 3600_000) return;
    this.busy ??= (async () => {
      const P = "https://people.googleapis.com/v1";
      const t = (token?: string) => (token ? `&pageToken=${encodeURIComponent(token)}` : "");
      await Promise.allSettled([
        this.pages((x) => `${P}/people:listDirectoryPeople?readMask=names,emailAddresses&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&pageSize=1000${t(x)}`, "people", "directory"),
        this.pages((x) => `${P}/people/me/connections?personFields=names,emailAddresses&pageSize=1000${t(x)}`, "connections", "contacts"),
        this.pages((x) => `${P}/otherContacts?readMask=names,emailAddresses&pageSize=1000${t(x)}`, "otherContacts", "other"),
      ]);
      this.loadedAt = Date.now();
      this.save();
    })().finally(() => (this.busy = undefined));
    await this.busy;
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify([...this.map.values()]), { mode: 0o600 });
    } catch {}
  }

  nameFor = (email: string) => this.map.get(email.trim().toLowerCase())?.name;

  async list(): Promise<Contact[]> {
    if (this.google.status().contacts) await this.refresh().catch(() => {});
    else this.save();
    return [...this.map.values()].sort((a, b) => RANK[a.source] - RANK[b.source] || a.name.localeCompare(b.name));
  }
}
