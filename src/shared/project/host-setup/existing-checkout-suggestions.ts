import { normalizeGitRemoteUrl } from '../../git/remotes/git-remote-identity'

export type ExistingCheckoutMatch = 'remote' | 'name'

export type ExistingCheckoutSuggestion = {
  path: string
  match: ExistingCheckoutMatch
}

export type ExistingCheckoutCandidate = {
  path: string
  folderName: string
  /** Fetch URLs of the checkout's remotes; empty for folders and remote-less repos. */
  remoteUrls: readonly string[]
}

export type FindExistingCheckoutsArgs = {
  projectName: string
  remoteUrl?: string
  kind: 'git' | 'folder'
  /** Host-specific roots the client knows about, such as a per-host worktree location. */
  extraRoots?: string[]
}

export const EXISTING_CHECKOUT_SUGGESTION_LIMIT = 5

// Forges treat owner/repo case-insensitively, so case alone never distinguishes two remotes here.
function remoteMatchKey(remoteUrl: string | undefined): string | null {
  return remoteUrl ? (normalizeGitRemoteUrl(remoteUrl)?.toLowerCase() ?? null) : null
}

function lastPathSegment(value: string): string {
  const segments = value.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? ''
}

/** Folder names that count as "same name": the project's name and its remote repository's name. */
export function existingCheckoutFolderNames(projectName: string, remoteUrl?: string): Set<string> {
  const names = new Set<string>()
  const projectFolder = projectName.trim().toLowerCase()
  if (projectFolder) {
    names.add(projectFolder)
  }
  const remoteKey = remoteMatchKey(remoteUrl)
  const repoFolder = remoteKey ? lastPathSegment(remoteKey) : ''
  if (repoFolder) {
    names.add(repoFolder)
  }
  return names
}

/** Same-remote checkouts first (same-named ones leading), then same-named folders; shallower paths break ties. */
export function rankExistingCheckouts(args: {
  candidates: readonly ExistingCheckoutCandidate[]
  projectName: string
  remoteUrl?: string
  limit?: number
}): ExistingCheckoutSuggestion[] {
  const remoteKey = remoteMatchKey(args.remoteUrl)
  const names = existingCheckoutFolderNames(args.projectName, args.remoteUrl)
  const seen = new Set<string>()
  const scored: { path: string; match: ExistingCheckoutMatch; score: number; depth: number }[] = []
  for (const candidate of args.candidates) {
    if (seen.has(candidate.path)) {
      continue
    }
    seen.add(candidate.path)
    const sameRemote =
      remoteKey !== null && candidate.remoteUrls.some((url) => remoteMatchKey(url) === remoteKey)
    const sameName = names.has(candidate.folderName.toLowerCase())
    if (!sameRemote && !sameName) {
      continue
    }
    scored.push({
      path: candidate.path,
      match: sameRemote ? 'remote' : 'name',
      score: (sameRemote ? 2 : 0) + (sameName ? 1 : 0),
      depth: candidate.path.split(/[\\/]/).filter(Boolean).length
    })
  }
  return scored
    .sort(
      (left, right) =>
        right.score - left.score || left.depth - right.depth || left.path.localeCompare(right.path)
    )
    .slice(0, args.limit ?? EXISTING_CHECKOUT_SUGGESTION_LIMIT)
    .map(({ path, match }) => ({ path, match }))
}
