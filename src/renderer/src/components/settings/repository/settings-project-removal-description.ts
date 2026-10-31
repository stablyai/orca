import { shallow } from 'zustand/vanilla/shallow'
import type { ProjectHostSetup } from '../../../../../shared/project-types'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import type { SettingsProjectRemovalScope } from '../settings-project-list'
import {
  getExecutionHostLabel,
  normalizeExecutionHostId
} from '../../../../../shared/execution-host'
import type { Repo } from '../../../../../shared/repo-types'
import { isWindowsAbsolutePathLike } from '../../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../../shared/wsl-paths'

import { translate } from '@/i18n/i18n'
export type RemovalContextRepo = Pick<
  Repo,
  'id' | 'path' | 'displayName' | 'executionHostId' | 'connectionId'
>

export function getRemoveProjectDescription(
  scope: SettingsProjectRemovalScope,
  repo: RemovalContextRepo
): string {
  if (scope.startsWith('host:')) {
    const host = getExecutionHostLabel(normalizeExecutionHostId(scope.slice(5)))
    const wsl = parseWslUncPath(repo.path)
    const surface = wsl
      ? `${wsl.distro} (WSL)`
      : isWindowsAbsolutePathLike(repo.path)
        ? 'Windows'
        : ''
    return translate(
      'settings.projectGrouping.removeHost',
      'Remove this project from Orca on {{host}}.',
      { host: surface ? `${host} · ${surface}` : host }
    )
  }
  if (scope === 'checkout') {
    return translate(
      'auto.components.settings.RepositoryPane.removeProjectCheckout',
      'Remove this checkout from Orca. Other checkouts of this project stay.'
    )
  }
  return translate(
    'auto.components.settings.RepositoryPane.removeProjectAllHosts',
    'Remove this project from Orca on all configured hosts.'
  )
}

export type SettingsProjectRemoval = {
  description: string
  signature: string
  addresses: readonly ProjectHostSetup[]
  targets: WorktreePurgeTarget[]
  closedFileIds: ReadonlySet<string>
}

export function sameRemovalCatalog(left: readonly Repo[], right: readonly Repo[]): boolean {
  return (
    left.length === right.length &&
    left.every((repo, index) => {
      const other = right[index]
      if (repo === other) {
        return true
      }
      const { projectGroupOrder: _rank, addedAt: _addedAt, ...meaning } = repo
      const { projectGroupOrder: _otherRank, addedAt: _otherAddedAt, ...otherMeaning } = other
      return shallow(meaning, otherMeaning)
    })
  )
}
