import type { AppState } from '@/store'

export const MANAGE_SESSIONS_SECTION_ID = 'terminal-manage-sessions'

/** Opens Settings › Terminal at the Manage Sessions section. */
export function openManageSessions(
  actions: Pick<AppState, 'setSettingsSearchQuery' | 'openSettingsTarget' | 'openSettingsPage'>
): void {
  // Why: a stale Settings search would hide the Manage Sessions section this points at.
  actions.setSettingsSearchQuery('')
  actions.openSettingsTarget({
    pane: 'terminal',
    repoId: null,
    sectionId: MANAGE_SESSIONS_SECTION_ID
  })
  actions.openSettingsPage()
}
