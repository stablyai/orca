import { getRepositoryLocalCommandsSectionId } from '@/components/settings/repository/repository-settings-targets'
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
  // Clear stale Settings search so it cannot hide this repo’s setup editor.
  setSettingsSearchQuery('')
  openSettingsTarget({
    pane: 'repo',
    repoId,
    hostId,
    sectionId: getRepositoryLocalCommandsSectionId(repoId)
  })
  openSettingsPage()
}
