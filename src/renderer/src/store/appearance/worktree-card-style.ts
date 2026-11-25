import type { AppState } from '../types'

export type DrawnWorktreeCardStyleState = Pick<AppState, 'settings' | 'worktreeCardsIntroChoice'>

/**
 * Whether the sidebar draws the experimental cards. The intro note can preview them without
 * saving, so read this instead of the setting anywhere cards are laid out, drawn, or fed data.
 * Menus and Settings that show the saved choice keep reading the setting.
 */
export function selectDrawsNewWorktreeCards(state: DrawnWorktreeCardStyleState): boolean {
  return (
    state.worktreeCardsIntroChoice === 'new' ||
    state.settings?.experimentalNewWorktreeCardStyle === true
  )
}
