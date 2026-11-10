import { useEffect, useMemo, useRef, useState } from "react";
import type { Contact } from "../shared/types";
import { hub } from "./App";

let cache: Contact[] | null = null;
let loading: Promise<Contact[]> | null = null;
const subs = new Set<(c: Contact[]) => void>();

function load(force = false) {
  if (loading && !force) return loading;
  loading = hub()
    .contacts()
    .then((c) => {
      cache = c;
      subs.forEach((f) => f(c));
      return c;
    })
    .catch(() => cache ?? []);
  return loading;
}

/** Contact book (directory, Google contacts, people you've emailed, names from mail) with a name lookup. */
export function useContacts() {
  const [list, setList] = useState<Contact[]>(cache ?? []);
  useEffect(() => {
    subs.add(setList);
    void load();
    const off = hub().onGoogleStatus(() => void load(true));
    return () => {
      subs.delete(setList);
      off();
    };
  }, []);
  const byEmail = useMemo(() => new Map(list.map((c) => [c.email, c])), [list]);
  const nameFor = (email: string) => byEmail.get(email.trim().toLowerCase())?.name;
  return { list, nameFor };
}

/** "Ada Lovelace" for a known address, else the address. */
export function Person({ email, name, me }: { email: string; name?: string; me?: string }) {
  const { nameFor } = useContacts();
  if (me && email.toLowerCase() === me.toLowerCase()) return <span title={email}>me</span>;
  const n = nameFor(email) ?? (name && name !== email ? name : undefined);
  return <span title={email}>{n ?? email}</span>;
}

/** Recipient chips with autocomplete from contacts. Emits bare emails. */
export function RecipientInput({ id, label, value, onChange, placeholder }: { id: string; label: string; value: string[]; onChange(v: string[]): void; placeholder?: string }) {
  const { list, nameFor } = useContacts();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [focus, setFocus] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return list.filter((c) => !value.includes(c.email) && (c.name.toLowerCase().includes(n) || c.email.includes(n))).slice(0, 8);
  }, [q, list, value]);
  const add = (email: string) => {
    const e = email.trim().toLowerCase().replace(/[,;]$/, "");
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !value.includes(e)) onChange([...value, e]);
    setQ("");
    setHi(0);
  };
  return (
    <div className={`rcpt ${focus ? "focus" : ""}`} onClick={() => input.current?.focus()}>
      <span className="rcpt-label">{label}</span>
      {value.map((e) => (
        <span key={e} className="rcpt-chip" title={e}>
          {nameFor(e) ?? e}
          <button aria-label={`Remove ${e}`} onClick={(x) => (x.stopPropagation(), onChange(value.filter((v) => v !== e)))}>
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        ref={input}
        value={q}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,;\s]$/.test(v) && /@/.test(v)) add(v);
          else setQ(v);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false);
          if (q.includes("@")) add(q);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, matches.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
          else if (e.key === "Enter" || e.key === "Tab") {
            if (matches[hi]) (e.preventDefault(), add(matches[hi].email));
            else if (q.includes("@")) (e.preventDefault(), add(q));
          } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
        }}
        spellCheck={false}
        autoComplete="off"
      />
      {focus && matches.length > 0 && (
        <div className="rcpt-menu">
          {matches.map((c, i) => (
            <button key={c.email} className={i === hi ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), add(c.email))}>
              <b>{c.name}</b>
              <span>{c.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
