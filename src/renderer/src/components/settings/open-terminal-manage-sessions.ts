import { useAppStore } from '@/store'

export const MANAGE_SESSIONS_SECTION_ID = 'terminal-manage-sessions'

export function openTerminalManageSessions(): void {
  const store = useAppStore.getState()
  store.setSettingsSearchQuery('')
  store.openSettingsTarget({
    pane: 'terminal',
    repoId: null,
    sectionId: MANAGE_SESSIONS_SECTION_ID
  })
  store.openSettingsPage()
}
