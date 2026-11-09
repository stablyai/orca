import type { Repo } from '../../../../../shared/repo-types'
import type { CloudSecretRepoChoice } from './CloudSecretsPane'

/** `github.com/owner/name` for a repo whose remote is on GitHub; repo secrets are keyed by it. */
export function cloudSecretRepoKey(repo: Pick<Repo, 'gitRemoteIdentity'>): string | null {
  const key = repo.gitRemoteIdentity?.canonicalKey?.trim().toLowerCase()
  return key && /^github\.com\/[^/]+\/[^/]+$/.test(key) ? key : null
}

export function cloudSecretRepoChoices(
  repos: readonly Pick<Repo, 'gitRemoteIdentity'>[]
): CloudSecretRepoChoice[] {
  const byKey = new Map<string, CloudSecretRepoChoice>()
  for (const repo of repos) {
    const key = cloudSecretRepoKey(repo)
    if (key && !byKey.has(key)) {
      byKey.set(key, { key, label: key.slice('github.com/'.length) })
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}
