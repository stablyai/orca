import type { AppState } from '../types'

export type DrawnWorktreeCardStyleState = Pick<AppState, 'settings' | 'worktreeCardsIntroChoice'>

export function savedNewWorktreeCards(settings: DrawnWorktreeCardStyleState['settings']): boolean {
  return (
    settings?.compactWorktreeHeader !== true && settings?.experimentalNewWorktreeCardStyle === true
  )
}

/**
 * Whether the sidebar draws the experimental cards. The intro note can preview them without
 * saving, so read this instead of the setting anywhere cards are laid out, drawn, or fed data.
 * Menus and Settings read savedNewWorktreeCards instead of the temporary preview.
 */
export function selectDrawsNewWorktreeCards(state: DrawnWorktreeCardStyleState): boolean {
  return state.worktreeCardsIntroChoice === 'new' || savedNewWorktreeCards(state.settings)
}

export function worktreeCardStyleUpdates(
  enabled: boolean,
  settings: DrawnWorktreeCardStyleState['settings']
) {
  return {
    experimentalNewWorktreeCardStyle: enabled,
    ...(enabled && settings?.compactWorktreeHeader === true ? { compactWorktreeHeader: false } : {})
  }
}
