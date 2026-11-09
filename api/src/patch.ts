import { createTwoFilesPatch } from "diff";
import type { SourceEdit } from "@pagepatch/shared";

export interface FileChange { path: string; before: string; after: string }

/**
 * Apply exact search/replace edits. Each `search` must occur exactly once in
 * the current file contents, otherwise the proposal is rejected (ambiguous or
 * hallucinated edits never reach a diff).
 */
export function applyEdits(files: Map<string, string>, edits: SourceEdit[]): { ok: true; changes: FileChange[] } | { ok: false; error: string } {
  const working = new Map<string, string>();
  for (const [i, e] of edits.entries()) {
    const current = working.get(e.path) ?? files.get(e.path);
    if (current === undefined) return { ok: false, error: `edit ${i}: unknown file ${e.path}` };
    const first = current.indexOf(e.search);
    if (first === -1) return { ok: false, error: `edit ${i}: search text not found in ${e.path}` };
    if (current.indexOf(e.search, first + 1) !== -1) return { ok: false, error: `edit ${i}: search text matches more than once in ${e.path}` };
    working.set(e.path, current.slice(0, first) + e.replace + current.slice(first + e.search.length));
  }
  const changes = [...working]
    .map(([path, after]) => ({ path, before: files.get(path)!, after }))
    .filter((c) => c.before !== c.after);
  if (changes.length === 0) return { ok: false, error: "edits produce no change" };
  return { ok: true, changes };
}

export function unifiedDiff(changes: FileChange[]): string {
  return changes
    .map((c) => createTwoFilesPatch(`a/${c.path}`, `b/${c.path}`, c.before, c.after, "", "", { context: 3 }))
    .join("\n");
}
