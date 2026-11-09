// Rank repo files likely to contain the selected section. Pure functions so
// they can be tested without GitHub.

const EDITABLE = /\.(html?|css|scss|jsx|tsx)$/i;
// .js/.ts are only eligible when they look like React components.
const MAYBE_COMPONENT = /\.(jsx?|tsx?)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.git|public\/assets)\//;
const SKIP_FILE = /(\.min\.|\.test\.|\.spec\.|\.stories\.|\.d\.ts$)/;

export const MAX_TREE_FILES = 3000;
export const MAX_FETCH = 40;
export const MAX_FILE_BYTES = 150_000;
export const MAX_MODEL_FILES = 5;

export interface TreeEntry { path: string; size: number; mode?: string }
export interface Signals { texts: string[]; classes: string[]; ids: string[]; tags: string[] }
export interface Candidate { path: string; score: number; reasons: string[] }

export function eligible(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .filter((e) => (EDITABLE.test(e.path) || MAYBE_COMPONENT.test(e.path)) && !SKIP_DIR.test(e.path) && !SKIP_FILE.test(e.path))
    .filter((e) => e.size <= MAX_FILE_BYTES)
    .slice(0, MAX_TREE_FILES);
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

/** Cheap first pass on paths only: component-ish names that match class/id tokens. */
export function rankPaths(entries: TreeEntry[], sig: Signals): TreeEntry[] {
  const tokens = new Set([...sig.classes, ...sig.ids].flatMap(words));
  const score = (p: string) => {
    const base = p.split("/").pop()!.toLowerCase();
    let s = 0;
    for (const t of tokens) if (base.includes(t)) s += 3;
    if (/\.(css|scss)$/.test(base)) s += 1;
    if (/^(index|app|page|layout)\./.test(base)) s += 1;
    if (/(^|\/)(src|app|components|pages)\//.test(p)) s += 1;
    return s;
  };
  return [...entries].sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path)).slice(0, MAX_FETCH);
}

/** HTML/CSS, or a .js/.ts/.jsx/.tsx file that renders JSX. Config, server, and utility modules are never edited. */
export function isEditableSource(path: string, content: string): boolean {
  if (/\.(html?|css|scss)$/i.test(path)) return true;
  if (!MAYBE_COMPONENT.test(path)) return false;
  return /(return|=>)\s*\(?\s*<[A-Za-z>]/.test(content);
}

/** Second pass on contents: visible text is the strongest signal, then classes/ids. */

export function scoreContents(path: string, content: string, sig: Signals): Candidate {
  const reasons: string[] = [];
  let score = 0;
  if (!isEditableSource(path, content)) return { path, score: 0, reasons: ["not a component"] };
  for (const t of sig.texts) {
    if (t.length >= 4 && content.includes(t)) { score += 10; reasons.push(`text "${t.slice(0, 40)}"`); }
  }
  for (const c of sig.classes) {
    if (new RegExp(`[\\s"'\`.]${escapeRe(c)}[\\s"'\`{,:]`).test(content)) { score += 3; reasons.push(`class .${c}`); }
  }
  for (const id of sig.ids) {
    if (content.includes(id)) { score += 3; reasons.push(`id #${id}`); }
  }
  return { path, score, reasons };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Ambiguous when nothing matched visible text, or two markup files tie on
 * the top score. Stylesheets alongside a component are expected, not ambiguous.
 */
export function isAmbiguous(ranked: Candidate[]): boolean {
  const markup = ranked.filter((c) => !/\.(css|scss)$/.test(c.path) && c.score > 0);
  if (markup.length === 0) return true;
  if (!markup[0].reasons.some((r) => r.startsWith("text"))) return true;
  return markup.length > 1 && markup[1].score === markup[0].score;
}
