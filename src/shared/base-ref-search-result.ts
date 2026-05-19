import type { BaseRefSearchResult } from './types'

const LEGACY_REMOTE_REF_PREFIXES = ['origin/', 'upstream/']

export function deriveLegacyLocalBranchName(refName: string): string {
  // Why: mixed-version runtimes only return display refs. Keep common remote
  // refs from reintroducing `origin/feature/foo` as the local branch name.
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
