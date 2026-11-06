import type { GlobalSettings } from '../global-settings-types'

export const WORKTREE_CARD_STYLES = ['classic', 'experimental-1', 'experimental-2'] as const

export type WorktreeCardStyle = (typeof WORKTREE_CARD_STYLES)[number]

type WorktreeCardStyleSettings = Pick<
  GlobalSettings,
  'worktreeCardStyle' | 'experimentalNewWorktreeCardStyle'
>

export function isWorktreeCardStyle(value: unknown): value is WorktreeCardStyle {
  return WORKTREE_CARD_STYLES.some((style) => style === value)
}

/**
 * Older clients only write the boolean, so it wins whenever the two disagree on
 * classic vs experimental; the style then only picks which experimental card.
 */
export function getWorktreeCardStyle(
  settings: Partial<WorktreeCardStyleSettings> | null | undefined
): WorktreeCardStyle {
  const legacyExperimental = settings?.experimentalNewWorktreeCardStyle === true
  const style = settings?.worktreeCardStyle
  if (isWorktreeCardStyle(style) && (style !== 'classic') === legacyExperimental) {
    return style
  }
  return legacyExperimental ? 'experimental-1' : 'classic'
}

/** Both experimental cards share the 1.0 data plumbing; only 2.0 changes what the card draws. */
export function isExperimentalWorktreeCardStyle(style: WorktreeCardStyle): boolean {
  return style !== 'classic'
}

export function worktreeCardStyleSettingsUpdate(
  style: WorktreeCardStyle
): Required<WorktreeCardStyleSettings> {
  return {
    worktreeCardStyle: style,
    experimentalNewWorktreeCardStyle: isExperimentalWorktreeCardStyle(style)
  }
}
