import { getRepositoryLocalCommandsSectionId } from '@/components/settings/repository-settings-targets'

export function openSetupScriptSettings(input: {
  repoId: string
  setSettingsSearchQuery: (query: string) => void
  openSettingsTarget: (target: { pane: 'repo'; repoId: string; sectionId: string }) => void
  openSettingsPage: () => void
}): void {
  const { openSettingsPage, openSettingsTarget, repoId, setSettingsSearchQuery } = input
  // Why: imported setup commands are local repo settings; a stale Settings
  // search should not hide the exact editor this action opens.
  setSettingsSearchQuery('')
  openSettingsTarget({
    pane: 'repo',
    repoId,
    sectionId: getRepositoryLocalCommandsSectionId(repoId)
  })
  openSettingsPage()
}
