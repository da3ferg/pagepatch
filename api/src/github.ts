// Minimal GitHub REST client using the user's GitHub App user-to-server token.
// That token can only reach repos where the app is installed AND the user has access.

const API = "https://api.github.com";

export class GhError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function gh<T = any>(token: string, path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: init.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pagepatch",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new GhError(res.status, `GitHub ${init.method ?? "GET"} ${path.split("?")[0]} -> ${res.status}`);
  if (res.status === 204) return undefined as T;
  if (!init.raw) return res.json() as Promise<T>;
  // Exact bytes: keep a BOM, and refuse non-UTF-8 files rather than mangling them in the commit.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await res.arrayBuffer()) as T;
  } catch {
    throw new GhError(422, `${path.split("?")[0]} is not UTF-8 text`);
  }
}

const seg = (p: string) => p.split("/").map(encodeURIComponent).join("/");
export const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export async function exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "pagepatch" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!res.ok || !body.access_token) throw new GhError(401, "GitHub sign-in failed");
  return body.access_token;
}

export const getUser = (t: string) => gh<{ id: number; login: string }>(t, "/user");

export async function listRepos(t: string) {
  const inst = await gh<{ installations: { id: number }[] }>(t, "/user/installations?per_page=100");
  const out: { owner: string; name: string; defaultBranch: string }[] = [];
  for (const i of inst.installations) {
    for (let page = 1; page <= 3; page++) {
      const r = await gh<{ repositories: any[] }>(t, `/user/installations/${i.id}/repositories?per_page=100&page=${page}`);
      out.push(...r.repositories.map((x) => ({ owner: x.owner.login, name: x.name, defaultBranch: x.default_branch })));
      if (r.repositories.length < 100) break;
    }
  }
  return out;
}

export const listBranches = async (t: string, o: string, r: string) =>
  (await gh<{ name: string }[]>(t, `${repoPath(o, r)}/branches?per_page=100`)).map((b) => b.name);

export async function branchHead(t: string, o: string, r: string, branch: string) {
  const b = await gh(t, `${repoPath(o, r)}/branches/${seg(branch)}`);
  return { sha: b.commit.sha as string, tree: b.commit.commit.tree.sha as string };
}

export async function canPush(t: string, o: string, r: string): Promise<boolean> {
  try {
    const repo = await gh(t, repoPath(o, r));
    return repo.permissions?.push === true;
  } catch (e) {
    if (e instanceof GhError && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

export async function getTree(t: string, o: string, r: string, treeSha: string) {
  const tree = await gh<{ tree: { path: string; type: string; mode: string; size?: number }[]; truncated: boolean }>(
    t, `${repoPath(o, r)}/git/trees/${treeSha}?recursive=1`);
  // Regular files only: symlinks (120000) and submodules are never edited.
  return tree.tree
    .filter((e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755"))
    .map((e) => ({ path: e.path, size: e.size ?? 0, mode: e.mode }));
}

export const getFile = (t: string, o: string, r: string, path: string, ref: string) =>
  gh<string>(t, `${repoPath(o, r)}/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`, { raw: true });

/** Commit file contents on top of `baseSha`. Returns the new commit sha. */
export async function createCommit(t: string, o: string, r: string, baseSha: string, baseTree: string, files: { path: string; content: string; mode: string }[], message: string) {
  const rp = repoPath(o, r);
  const tree = await gh(t, `${rp}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: f.mode, type: "blob", content: f.content })),
    }),
  });
  const commit = await gh(t, `${rp}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseSha] }),
  });
  return commit.sha as string;
}

/** Create the branch, or accept it if a previous attempt already created it at the same commit. */
export async function ensureBranch(t: string, o: string, r: string, branch: string, sha: string) {
  const rp = repoPath(o, r);
  try {
    await gh(t, `${rp}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }) });
  } catch (e) {
    if (!(e instanceof GhError && e.status === 422)) throw e;
    const ref = await gh(t, `${rp}/git/ref/heads/${seg(branch)}`);
    if (ref.object.sha !== sha) throw new GhError(409, "PagePatch branch exists at a different commit");
  }
}

export async function ensureDraftPr(t: string, o: string, r: string, branch: string, base: string, title: string, body: string) {
  const rp = repoPath(o, r);
  const open = await gh<any[]>(t, `${rp}/pulls?state=open&head=${encodeURIComponent(`${o}:${branch}`)}`);
  if (open.length) return open[0].html_url as string;
  const pr = await gh(t, `${rp}/pulls`, { method: "POST", body: JSON.stringify({ title, body, head: branch, base, draft: true }) });
  return pr.html_url as string;
}
