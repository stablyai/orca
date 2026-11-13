import type { BaseRefSearchResult } from './repo-types'

const LEGACY_REMOTE_REF_PREFIXES = ['origin/', 'upstream/']

export function deriveLegacyLocalBranchName(refName: string): string {
  if (refName.startsWith('refs/heads/')) {
    return refName.slice('refs/heads/'.length)
  }
  if (refName.startsWith('refs/remotes/')) {
    return refName.slice('refs/remotes/'.length).split('/').slice(1).join('/')
  }
  // Older runtimes return display refs only; strip common remote prefixes so origin/feature/foo cannot become the local name.
  for (const prefix of LEGACY_REMOTE_REF_PREFIXES) {
    if (refName.startsWith(prefix) && refName.length > prefix.length) {
      return refName.slice(prefix.length)
    }
  }
  return refName
}

export function legacyBaseRefSearchResult(refName: string): BaseRefSearchResult {
  return {
    refName,
    localBranchName: deriveLegacyLocalBranchName(refName)
  }
}
