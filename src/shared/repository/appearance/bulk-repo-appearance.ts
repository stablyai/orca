import { getRepoExecutionHostId, type ExecutionHostId } from '../../execution-host/execution-host'
import { withoutHiddenRepos } from '../../project/catalog/hidden-projects'
import type { Repo } from '../repo-types'
import type { RepoIcon } from './repo-icon'
import { repoMarkKey } from './repo-mark-appearance'

export type BulkRepoAppearanceSnapshot = {
  repoIcon: RepoIcon | null
  badgeColor: string
}

export type BulkRepoAppearanceEntry = {
  repoId: string
  hostId: ExecutionHostId
  updates: BulkRepoAppearanceSnapshot
  previous: BulkRepoAppearanceSnapshot
}

type BulkRepoInput = Pick<Repo, 'id' | 'badgeColor' | 'repoIcon' | 'hiddenAt'> & {
  executionHostId?: Repo['executionHostId']
  connectionId?: Repo['connectionId']
}

/** Monograms and repository avatars identify a single project; icons, emoji, and default reset can apply across all. */
export function canShareRepoIconAcrossProjects(repoIcon: RepoIcon | null | undefined): boolean {
  return repoIcon == null || repoIcon.type === 'lucide' || repoIcon.type === 'emoji'
}

function sameRepoIcon(a: RepoIcon | null, b: RepoIcon | null): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.type !== b.type) {
    return false
  }
  if (a.type === 'lucide' && b.type === 'lucide') {
    return a.name === b.name
  }
  if (a.type === 'emoji' && b.type === 'emoji') {
    return a.emoji === b.emoji
  }
  if (a.type === 'letters' && b.type === 'letters') {
    return a.text === b.text
  }
  return a.type === 'image' && b.type === 'image' && a.src === b.src && a.source === b.source
}

export function planBulkRepoAppearanceUpdates(
  source: BulkRepoInput,
  repos: readonly BulkRepoInput[]
): BulkRepoAppearanceEntry[] {
  const desiredIcon = source.repoIcon ?? null
  if (!canShareRepoIconAcrossProjects(desiredIcon)) {
    return []
  }
  const sourceKey = repoMarkKey(source)
  const updates: BulkRepoAppearanceEntry[] = []
  for (const target of withoutHiddenRepos(repos)) {
    if (repoMarkKey(target) === sourceKey) {
      continue
    }
    const currentIcon = target.repoIcon ?? null
    if (sameRepoIcon(currentIcon, desiredIcon) && target.badgeColor === source.badgeColor) {
      continue
    }
    updates.push({
      repoId: target.id,
      hostId: getRepoExecutionHostId(target),
      updates: { repoIcon: desiredIcon, badgeColor: source.badgeColor },
      previous: { repoIcon: currentIcon, badgeColor: target.badgeColor }
    })
  }
  return updates
}
