import type { RepoWorktree, SessionGroup, SessionState } from "../shared/types";
import { hub } from "./App";
import type { MenuItem } from "./Menu";

/** One menu for a session, used by both the sidebar right-click and the header ⋯ button. */
export function sessionMenuItems(opts: {
  s: SessionState;
  groups: SessionGroup[];
  allTags: string[];
  onRename(): void;
  toast(text: string, action?: { label: string; run: () => void }): void;
  /** Repo worktrees, fetched by the caller just before opening the menu. */
  worktrees?: RepoWorktree[];
}): MenuItem[] {
  const { s, groups } = opts;
  if (s.archived) {
    return [
      { label: "Unarchive", key: "u", onSelect: () => hub().setArchived(s.id, false) },
      { type: "separator" },
      {
        label: "Delete permanently…",
        key: "d",
        danger: true,
        onSelect: () => confirm(`Delete "${s.title}" permanently? This can't be undone.`) && hub().remove(s.id),
      },
    ];
  }

  const tags = s.tags ?? [];
  const tagChoices = [...new Set([...opts.allTags, ...tags])];
  const toggleTag = (t: string) => hub().setTags(s.id, tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);

  const items: MenuItem[] = [{ label: "Rename", key: "r", onSelect: opts.onRename }];
  if (!s.isManager) {
    items.push(
      {
        label: "Move to group",
        submenu: [
          { label: "No group", checked: !s.groupId, onSelect: () => hub().moveToGroup(s.id, null) },
          ...groups.map((g) => ({ label: g.name, checked: s.groupId === g.id, onSelect: () => hub().moveToGroup(s.id, g.id) })),
          { type: "separator" },
          {
            type: "input",
            placeholder: "New group…",
            onSubmit: async (name) => {
              const g = await hub().createGroup(name);
              await hub().moveToGroup(s.id, g.id);
            },
          },
        ],
      },
      {
        label: "Tags",
        submenu: [
          ...tagChoices.map((t) => ({ label: t, checked: tags.includes(t), onSelect: () => toggleTag(t) })),
          { type: "separator" },
          { type: "input", placeholder: "New tag…", onSubmit: (t) => hub().setTags(s.id, [...tags, t]) },
        ],
      },
    );
  }
  items.push({ label: "Reveal folder", key: "o", onSelect: () => hub().revealFile(s.cwd) });
  if (!s.isManager && !s.isCloud && !s.isEmail)
    items.push({
      label: s.engine === "cursor" ? "Fork (not for Cursor)" : "Fork",
      key: "f",
      onSelect: () =>
        s.engine === "cursor"
          ? opts.toast("Cursor chats can't be forked yet")
          : void hub()
              .forkSession(s.id)
              .then((f) => (opts.toast(`Forked "${s.title}"`), window.dispatchEvent(new CustomEvent("happy:open-session", { detail: f.id }))))
              .catch((e: Error) => opts.toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))),
    });
  const others = (opts.worktrees ?? []).filter((w) => !w.primary);
  if (!s.isManager && others.length) {
    items.push({
      label: "Worktrees",
      submenu: [
        { type: "header", label: "track in this session" },
        // Tracked ones first; the branch name alone (the folder is the same name with the repo prefix).
        ...[...others].sort((a, b) => Number(b.linked) - Number(a.linked)).map((w) => ({
          label: w.branch ?? w.path.split("/").pop()!,
          checked: w.linked,
          onSelect: () => void (w.linked ? hub().unlinkWorktree(s.id, w.path) : hub().linkWorktree(s.id, w.path)),
        })),
      ],
    });
  }
  if (s.worktree && !s.worktree.removed) {
    items.push({
      label: "Remove worktree…",
      key: "x",
      hint: s.git?.merged ? "merged" : s.git?.dirty ? "has changes" : "",
      onSelect: () => {
        if (!confirm(`Remove worktree ${s.worktree!.path}?\n\nGit refuses if it has uncommitted changes. The branch "${s.worktree!.branch}" is deleted only if it's merged.`)) return;
        hub()
          .removeWorktree(s.id)
          .then((r) => opts.toast(r.branchDeleted ? `removed worktree and branch ${s.worktree!.branch}` : `removed worktree · branch kept (not merged)`))
          .catch((e: Error) => opts.toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
      },
    });
  }
  if (!s.isManager) {
    items.push(
      { type: "separator" },
      {
        label: "Archive",
        key: "a",
        onSelect: () => {
          void hub().setArchived(s.id, true);
          opts.toast(`Archived “${s.title}”`, { label: "Undo", run: () => hub().setArchived(s.id, false) });
        },
      },
    );
  }
  return items;
}
