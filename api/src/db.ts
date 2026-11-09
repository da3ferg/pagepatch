import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL ?? "postgres://localhost/pagepatch", {
  max: 5,
  onnotice: () => {},
  ssl: process.env.DATABASE_URL?.includes("render.com") ? "require" : undefined,
});

export const PROPOSAL_TTL_MIN = 60;

export async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      github_user_id bigint NOT NULL,
      owner text NOT NULL,
      repo text NOT NULL,
      base_branch text NOT NULL,
      base_sha text NOT NULL,
      base_tree text NOT NULL,
      summary text NOT NULL,
      diff text NOT NULL,
      files jsonb NOT NULL,
      commit_sha text,
      pr_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL
    )`;
  // Proposals hold repo file contents; don't keep them around.
  await sql`DELETE FROM proposals WHERE expires_at < now() - interval '1 day'`;
}

export interface Proposal {
  id: string;
  github_user_id: string;
  owner: string;
  repo: string;
  base_branch: string;
  base_sha: string;
  base_tree: string;
  summary: string;
  diff: string;
  files: { path: string; content: string; mode: string }[];
  commit_sha: string | null;
  pr_url: string | null;
  expires_at: Date;
}

export async function saveProposal(p: Omit<Proposal, "id" | "commit_sha" | "pr_url" | "expires_at">): Promise<string> {
  const [row] = await sql`
    INSERT INTO proposals (github_user_id, owner, repo, base_branch, base_sha, base_tree, summary, diff, files, expires_at)
    VALUES (${p.github_user_id}, ${p.owner}, ${p.repo}, ${p.base_branch}, ${p.base_sha}, ${p.base_tree},
            ${p.summary}, ${p.diff}, ${sql.json(p.files)}, now() + ${PROPOSAL_TTL_MIN + " minutes"}::interval)
    RETURNING id`;
  return row.id;
}

export async function getProposal(id: string, githubUserId: number): Promise<Proposal | null> {
  const [row] = await sql<Proposal[]>`
    SELECT * FROM proposals WHERE id = ${id} AND github_user_id = ${githubUserId}`;
  return row ?? null;
}

export const PENDING = "pending";
export const claimCommit = async (id: string) =>
  (await sql`UPDATE proposals SET commit_sha = ${PENDING} WHERE id = ${id} AND commit_sha IS NULL RETURNING id`).length === 1;
export const releaseCommit = (id: string) => sql`UPDATE proposals SET commit_sha = NULL WHERE id = ${id} AND commit_sha = ${PENDING}`;
export const setCommit = (id: string, sha: string) => sql`UPDATE proposals SET commit_sha = ${sha} WHERE id = ${id}`;
export const setPr = (id: string, url: string) => sql`UPDATE proposals SET pr_url = ${url} WHERE id = ${id}`;
