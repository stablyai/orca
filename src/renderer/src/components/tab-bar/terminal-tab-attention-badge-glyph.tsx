import React from 'react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { FilledBellIcon } from '@/components/sidebar/WorktreeCardHelpers'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import { translate } from '@/i18n/i18n'
import type { TerminalTabAttentionBadge } from './terminal-tab-activity-status'

/**
 * The sentence a badge says. `unread` borrows the tab bar's key on purpose — same
 * bell, same words — so it ships translated instead of falling back to English for
 * the sake of a namespace.
 */
export function terminalTabAttentionBadgeLabel(badge: TerminalTabAttentionBadge): string {
  return badge === 'unread'
    ? translate(
        'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
        'Unread agent completion'
      )
    : getWorktreeStatusLabel(badge)
}

/**
 * One glyph for the whole `resolveTerminalTabAttentionBadge` ladder: the amber bell
 * for `unread`, `AgentStateDot` for every agent state (it owns those glyphs app-wide).
 * Shared by Cmd+J's recent rows and the session grid's card header — the resolver and
 * the glyph travel together, the surrounding layout does not.
 *
 * Purely visual: both call sites sit under `pointer-events-none`, so neither can hover
 * a tooltip. They name the badge themselves with `terminalTabAttentionBadgeLabel`.
 */
export function TerminalTabAttentionBadgeGlyph({
  badge
}: {
  badge: TerminalTabAttentionBadge
}): React.JSX.Element {
  return badge === 'unread' ? (
    <FilledBellIcon className="size-2.5 text-amber-500 drop-shadow-sm" />
  ) : (
    <AgentStateDot state={badge} size="sm" title={null} />
  )
}
