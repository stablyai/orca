import type { Repo } from '../../../shared/types'

export function normalizeRepoDisplayNameKey(name: string): string {
  return name.trim().toLowerCase()
}

export function getDuplicateRepoDisplayNames(repos: readonly Repo[]): Set<string> {
  const seenNames = new Set<string>()
  const duplicateNames = new Set<string>()

  for (const repo of repos) {
    const name = normalizeRepoDisplayNameKey(repo.displayName)
    if (seenNames.has(name)) {
      duplicateNames.add(name)
      continue
    }
    seenNames.add(name)
  }

  return duplicateNames
}
