import { useAppStore } from '@/store'
import { stripLeadingAgentTitleDecoration } from '../../../shared/agent-title-decoration'
import type { WorktreeStatus } from './worktree-status'

// Why: Orca strips the agent's own leading glyph so a tab does not show two
// icons for one agent (agent-title-decoration.ts). This puts back a single
// glyph that reports *state* rather than identity, and only when the user asks
// for it — the provider icon still owns "which agent".
const TAB_STATUS_EMOJI: Partial<Record<WorktreeStatus, string>> = {
  working: '⚙',
  permission: '✋',
  done: '✅'
}

export function getTabStatusEmoji(status: WorktreeStatus | null | undefined): string | null {
  return (status && TAB_STATUS_EMOJI[status]) ?? null
}

// Why: the status resolver reruns on every store write and the status itself
// changes as the agent works, so stripping any known marker first keeps the
// prefix idempotent instead of stacking "✅ ⚙ Build".
const LEADING_TAB_STATUS_EMOJI_RE = new RegExp(
  `^(?:${Object.values(TAB_STATUS_EMOJI).join('|')})\\s+`
)

export function stripTabStatusEmoji(title: string): string {
  return title.replace(LEADING_TAB_STATUS_EMOJI_RE, '')
}

/**
 * Prefix a tab title with a one-glyph status marker.
 *
 * Returns the title untouched when the setting is off, when the status carries
 * no marker ('active' / 'inactive' are not states worth a glyph), or when the
 * title is empty — a lone glyph would read as a blank tab.
 */
export function prefixTabTitleWithStatusEmoji(
  title: string,
  status: WorktreeStatus | null | undefined,
  enabled: boolean
): string {
  if (!enabled) {
    return title
  }
  const emoji = getTabStatusEmoji(status)
  if (!emoji || !title.trim()) {
    return title
  }
  return `${emoji} ${stripTabStatusEmoji(title)}`
}

/**
 * The label a tab shows: the manual rename if there is one, otherwise the live
 * title with the agent's own leading glyph stripped, optionally prefixed with a
 * state marker.
 */
export function resolveTabDisplayTitle(args: {
  customTitle: string | null | undefined
  title: string
  hasAgent: boolean
  status: WorktreeStatus | null | undefined
  statusEmojiEnabled: boolean
}): string {
  const resolved =
    args.customTitle ?? (args.hasAgent ? stripLeadingAgentTitleDecoration(args.title) : args.title)
  return prefixTabTitleWithStatusEmoji(resolved, args.status, args.statusEmojiEnabled)
}

/** Selector-scoped wrapper so a tab reads the setting as one primitive. */
export function useTabDisplayTitle(
  tab: { customTitle?: string | null; title: string },
  hasAgent: boolean,
  status: WorktreeStatus | null | undefined
): string {
  const statusEmojiEnabled = useAppStore((s) => s.settings?.tabStatusEmoji === true)
  return resolveTabDisplayTitle({
    customTitle: tab.customTitle,
    title: tab.title,
    hasAgent,
    status,
    statusEmojiEnabled
  })
}
