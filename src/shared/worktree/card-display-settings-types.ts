/** What the 2.0 card draws before the name. */
export type WorktreeCardIconStyle = 'tabs' | 'pr' | 'none' | 'ai'

export const WORKTREE_CARD_ICON_STYLES: readonly WorktreeCardIconStyle[] = [
  'tabs',
  'pr',
  'none',
  'ai'
]

export type WorktreeCardDisplaySettings = {
  /** Which worktree card the sidebar draws; `experimentalNewWorktreeCardStyle` stays in step for older clients. */
  worktreeCardStyle?: 'classic' | 'experimental-1' | 'experimental-2'
  /** 2.0 card: draw the details row (Card display items) under each name; off by default. */
  worktreeCardDetailsRow?: boolean
  /** 2.0 card: the leading icon style for every card; tabs when unset. */
  worktreeCardIcon?: WorktreeCardIconStyle
}

export function getWorktreeCardIconStyle(
  settings: WorktreeCardDisplaySettings | null | undefined
): WorktreeCardIconStyle {
  const value = settings?.worktreeCardIcon
  return value && WORKTREE_CARD_ICON_STYLES.includes(value) ? value : 'tabs'
}
