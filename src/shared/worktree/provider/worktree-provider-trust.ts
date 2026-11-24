/** Content-hash allowlist for repo-level provider commands, written only by an explicit trust command. */
export const MAX_TRUSTED_WORKTREE_PROVIDER_HASHES = 20
export const MAX_WORKTREE_PROVIDER_TRUST_FILE_BYTES = 256 * 1024

export type WorktreeProviderTrustEntry = {
  contentHash: string
  approvedAt: number
  previousContentHashes?: string[]
}

export type WorktreeProviderTrustFile = {
  repos: Record<string, WorktreeProviderTrustEntry>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above proves a plain object.
  return value as Record<string, unknown>
}

function approvedHashes(entry: WorktreeProviderTrustEntry | undefined): string[] {
  if (!entry) {
    return []
  }
  const hashes = [entry.contentHash, ...(entry.previousContentHashes ?? [])].filter(
    (hash): hash is string => typeof hash === 'string' && hash.length > 0 && hash.length <= 128
  )
  return [...new Set(hashes)].slice(0, MAX_TRUSTED_WORKTREE_PROVIDER_HASHES)
}

export function parseWorktreeProviderTrustFile(content: string): WorktreeProviderTrustFile {
  if (content.length > MAX_WORKTREE_PROVIDER_TRUST_FILE_BYTES) {
    return { repos: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { repos: {} }
  }
  const record = asRecord(parsed)
  const repos = asRecord(record?.repos)
  if (!repos) {
    return { repos: {} }
  }
  const normalized: Record<string, WorktreeProviderTrustEntry> = {}
  for (const [repoId, value] of Object.entries(repos)) {
    if (!repoId || repoId.length > 512) {
      continue
    }
    const entry = asRecord(value)
    const contentHash =
      typeof entry?.contentHash === 'string' && entry.contentHash.length <= 128
        ? entry.contentHash
        : undefined
    const approvedAt =
      typeof entry?.approvedAt === 'number' && Number.isFinite(entry.approvedAt)
        ? entry.approvedAt
        : undefined
    if (!contentHash || approvedAt === undefined) {
      continue
    }
    const previous = Array.isArray(entry?.previousContentHashes)
      ? entry.previousContentHashes
          .filter(
            (hash): hash is string =>
              typeof hash === 'string' && hash.length > 0 && hash.length <= 128
          )
          .slice(0, MAX_TRUSTED_WORKTREE_PROVIDER_HASHES - 1)
      : []
    normalized[repoId] = {
      contentHash,
      approvedAt,
      ...(previous.length > 0 ? { previousContentHashes: previous } : {})
    }
  }
  return { repos: normalized }
}

export function isWorktreeProviderConfigTrusted(
  file: WorktreeProviderTrustFile,
  repoId: string,
  contentHash: string
): boolean {
  return approvedHashes(file.repos[repoId]).includes(contentHash)
}

/** Returns `file` itself when the approval is already the latest one recorded. */
export function withWorktreeProviderConfigTrusted(
  file: WorktreeProviderTrustFile,
  repoId: string,
  contentHash: string,
  approvedAt = Date.now()
): WorktreeProviderTrustFile {
  if (file.repos[repoId]?.contentHash === contentHash) {
    return file
  }
  const previous = approvedHashes(file.repos[repoId])
    .filter((hash) => hash !== contentHash)
    .slice(0, MAX_TRUSTED_WORKTREE_PROVIDER_HASHES - 1)
  return {
    ...file,
    repos: {
      ...file.repos,
      [repoId]: {
        contentHash,
        approvedAt,
        ...(previous.length > 0 ? { previousContentHashes: previous } : {})
      }
    }
  }
}
