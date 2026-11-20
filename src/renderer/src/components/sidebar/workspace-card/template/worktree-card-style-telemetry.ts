import { track } from '@/diagnostics/telemetry/telemetry'
import type { EventProps } from '../../../../../../shared/telemetry/telemetry-event-classification'

export type WorktreeCardStyleChangeSource = EventProps<'worktree_card_style_changed'>['source']
type WorktreeCardsIntroAction = EventProps<'worktree_cards_intro_action'>['action']
type WorktreeCardStyle = EventProps<'worktree_card_style_changed'>['style']

export function trackWorktreeCardsIntroAction(
  action: WorktreeCardsIntroAction,
  switchPosition: WorktreeCardStyle
): void {
  track('worktree_cards_intro_action', { action, switch_position: switchPosition })
}

export function trackWorktreeCardStyleChanged(
  experimental: boolean,
  source: WorktreeCardStyleChangeSource
): void {
  track('worktree_card_style_changed', { style: experimental ? 'new' : 'classic', source })
}
