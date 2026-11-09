// "Move to this computer" for an Orca Cloud workspace: what the VM packs (over orcad, E2EE — the
// control plane never sees repository content) and how the desktop remaps agent chats to the new
// local path. Pure helpers here; the main-process flow is src/main/hosted-sandbox/cloud-transfer.ts.
import { z } from 'zod'

/** Scratch directory inside the cloud worktree; excluded from git and removed after the download. */
export const CLOUD_TRANSFER_DIR = '.orca-transfer'
export const CLOUD_TRANSFER_ARCHIVE = `${CLOUD_TRANSFER_DIR}/transfer.tar`
export const CLOUD_TRANSFER_SCRIPT = `${CLOUD_TRANSFER_DIR}/pack.sh`
export const CLOUD_TRANSFER_LOG = `${CLOUD_TRANSFER_DIR}/pack.log`
export const CLOUD_TRANSFER_RESULT = `${CLOUD_TRANSFER_DIR}/result.json`
/** Refuse absurd transfers instead of filling the user's disk; a git bundle of a big repo fits easily. */
export const CLOUD_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024

export const CloudTransferManifestSchema = z
  .object({
    version: z.literal(1),
    root: z.string().startsWith('/').max(4096),
    branch: z.string().max(255).nullable(),
    head: z.string().max(64).nullable(),
    upstream: z.string().max(255).nullable(),
    hasBundle: z.boolean(),
    stagedBytes: z.number().int().nonnegative(),
    unstagedBytes: z.number().int().nonnegative(),
    untrackedFiles: z.number().int().nonnegative(),
    claudeSessions: z.number().int().nonnegative(),
    codexSessions: z.number().int().nonnegative()
  })
  .strict()
export type CloudTransferManifest = z.infer<typeof CloudTransferManifestSchema>

export const CloudTransferResultSchema = z
  .object({ manifest: CloudTransferManifestSchema, archiveBytes: z.number().int().nonnegative() })
  .strict()

/**
 * Bash run in the cloud worktree (cwd) by an orcad terminal. Writes one tar with: a git bundle of
 * HEAD, its branch and upstream; staged and unstaged binary diffs; untracked non-ignored files;
 * Claude Code project sessions and Codex rollouts whose cwd is this worktree; a manifest.
 */
export function cloudTransferPackScript(): string {
  return String.raw`set -euo pipefail
root="$PWD"
out="$root/${CLOUD_TRANSFER_DIR}"
stage="$out/stage"
# A result left by an earlier run (whose cleanup failed) must never be read as this run's.
rm -rf "$stage" "$out/transfer.tar" "$out/result.json"
mkdir -p "$stage/claude" "$stage/codex"
exclude="$(git rev-parse --git-path info/exclude)"
mkdir -p "$(dirname "$exclude")"
grep -qxF '${CLOUD_TRANSFER_DIR}/' "$exclude" 2>/dev/null || echo '${CLOUD_TRANSFER_DIR}/' >>"$exclude"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
head="$(git rev-parse --verify --quiet HEAD || true)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
has_bundle=false
if [ -n "$head" ]; then
  refs=(HEAD)
  [ -n "$branch" ] && refs+=("refs/heads/$branch")
  [ -n "$upstream" ] && git rev-parse --verify --quiet "refs/remotes/$upstream" >/dev/null && refs+=("refs/remotes/$upstream")
  git bundle create "$stage/repo.bundle" "${'$'}{refs[@]}" >/dev/null 2>&1 && has_bundle=true
  git diff --cached --binary >"$stage/staged.patch"
  git diff --binary >"$stage/unstaged.patch"
else
  : >"$stage/staged.patch"
  : >"$stage/unstaged.patch"
fi
git ls-files --others --exclude-standard -z | { grep -zv '^${CLOUD_TRANSFER_DIR}/' || true; } >"$stage/untracked.list"
untracked=$(tr -cd '\0' <"$stage/untracked.list" | wc -c | tr -d ' ')
tar --null -T "$stage/untracked.list" -czf "$stage/untracked.tgz"
rm -f "$stage/untracked.list"
enc="$(printf '%s' "$root" | sed 's#[^A-Za-z0-9]#-#g')"
claude_home="${'$'}{CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# Session transcripts only (*.jsonl, regular files): not memory/ or anything else in the folder.
if [ -d "$claude_home/projects/$enc" ] && [ ! -L "$claude_home/projects/$enc" ]; then
  find "$claude_home/projects/$enc" -maxdepth 1 -type f -name '*.jsonl' -exec cp -p {} "$stage/claude/" \;
fi
claude=$(find "$stage/claude" -name '*.jsonl' -type f | wc -l | tr -d ' ')
codex_home="${'$'}{CODEX_HOME:-$HOME/.codex}"
if [ -d "$codex_home/sessions" ]; then
  (cd "$codex_home/sessions" && grep -rlF --include='*.jsonl' -e "\"cwd\":\"$root\"" -e "\"cwd\": \"$root\"" . 2>/dev/null || true) |
    while IFS= read -r f; do
      [ -f "$codex_home/sessions/$f" ] && [ ! -L "$codex_home/sessions/$f" ] || continue
      mkdir -p "$stage/codex/$(dirname "$f")"; cp "$codex_home/sessions/$f" "$stage/codex/$f"
    done
fi
codex=$(find "$stage/codex" -name '*.jsonl' -type f | wc -l | tr -d ' ')
ORCA_T_ROOT="$root" ORCA_T_BRANCH="$branch" ORCA_T_HEAD="$head" ORCA_T_UPSTREAM="$upstream" \
ORCA_T_BUNDLE="$has_bundle" ORCA_T_STAGED="$(wc -c <"$stage/staged.patch")" ORCA_T_UNSTAGED="$(wc -c <"$stage/unstaged.patch")" \
ORCA_T_UNTRACKED="$untracked" ORCA_T_CLAUDE="$claude" ORCA_T_CODEX="$codex" node -e '
const e = process.env, n = (v) => Number(String(v).trim()) || 0, s = (v) => (v ? v : null)
process.stdout.write(JSON.stringify({ version: 1, root: e.ORCA_T_ROOT, branch: s(e.ORCA_T_BRANCH), head: s(e.ORCA_T_HEAD),
  upstream: s(e.ORCA_T_UPSTREAM), hasBundle: e.ORCA_T_BUNDLE === "true", stagedBytes: n(e.ORCA_T_STAGED),
  unstagedBytes: n(e.ORCA_T_UNSTAGED), untrackedFiles: n(e.ORCA_T_UNTRACKED), claudeSessions: n(e.ORCA_T_CLAUDE), codexSessions: n(e.ORCA_T_CODEX) }))
' >"$stage/manifest.json"
tar -cf "$out/transfer.tar" -C "$stage" .
# The desktop reads this small file (not the log) and checks the size before downloading.
printf '{"manifest":%s,"archiveBytes":%s}\n' "$(cat "$stage/manifest.json")" "$(wc -c <"$out/transfer.tar" | tr -d ' ')" >"$out/result.json"
rm -rf "$stage"
echo ORCA_TRANSFER_OK
`
}

/** Claude Code names a project's session folder after its cwd with every non-alphanumeric as `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrites the cloud worktree path to the local one in a session transcript (JSONL), matching the
 * path as it appears inside JSON strings, only as a whole path or a path prefix — `/a/project`
 * must not rewrite `/a/project-two`. The replacement is JSON-escaped so every line stays valid.
 */
export function remapSessionTranscript(text: string, fromRoot: string, toRoot: string): string {
  const from = JSON.stringify(fromRoot).slice(1, -1)
  const to = JSON.stringify(toRoot).slice(1, -1)
  return text.replace(new RegExp(`${escapeRegExp(from)}(?=$|[/"\\\\\\s'\`:])`, 'g'), () => to)
}

/** Local branch name for the transferred branch: its own name unless that is taken by different work. */
export function pickTransferBranchName(
  branch: string | null,
  taken: (name: string) => boolean,
  fallback: string
): string {
  const base = branch && /^[A-Za-z0-9._/-]{1,200}$/.test(branch) ? branch : fallback
  if (!taken(base)) {
    return base
  }
  for (let i = 1; i < 100; i++) {
    const candidate = `${base}-cloud${i === 1 ? '' : `-${i}`}`
    if (!taken(candidate)) {
      return candidate
    }
  }
  return `${base}-cloud-${Date.now().toString(36)}`
}
