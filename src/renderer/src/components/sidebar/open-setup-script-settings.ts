import { getRepositoryLocalCommandsSectionId } from '@/components/settings/repository-settings-targets'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function openSetupScriptSettings(input: {
  repoId: string
  hostId: ExecutionHostId
  setSettingsSearchQuery: (query: string) => void
  openSettingsTarget: (target: {
    pane: 'repo'
    repoId: string
    hostId: ExecutionHostId
    sectionId: string
  }) => void
  openSettingsPage: () => void
}): void {
  const { hostId, openSettingsPage, openSettingsTarget, repoId, setSettingsSearchQuery } = input
  // Why: imported setup commands are local repo settings; a stale Settings
  // search should not hide the exact editor this action opens.
  setSettingsSearchQuery('')
  openSettingsTarget({
    pane: 'repo',
    repoId,
    hostId,
    sectionId: getRepositoryLocalCommandsSectionId(repoId)
  })
  openSettingsPage()
}
