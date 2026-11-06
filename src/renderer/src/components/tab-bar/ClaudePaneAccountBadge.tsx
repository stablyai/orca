import { useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  getClaudePaneAccountSnapshot,
  subscribeClaudePaneAccounts
} from '@/lib/claude-pane-account-assignments'
import { useFocusedTerminalPtyId } from '@/lib/use-tab-agent'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import type { NativeChatTabSession } from './tab-session-history-switch'

export function claudeSessionCountLabel(count: number): string {
  if (count === 1) {
    return translate('accounts.claude.pool.sessionsOne', '1 session')
  }
  return translate('accounts.claude.pool.sessionsOther', '{{count}} sessions', { count })
}

/** Presentational chip. The tab header passes the label the host already shortened. */
export function ClaudePaneAccountChip({
  label,
  email
}: {
  label: string
  email: string
}): React.JSX.Element {
  const name = translate('accounts.claude.pool.paneBadge', 'Claude account {{label}}', { label })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="hostContext" aria-label={name} className="mr-1 max-w-32">
          <span className="truncate">{label}</span>
        </Badge>
      </TooltipTrigger>
      {email ? (
        <TooltipContent side="bottom" sideOffset={6}>
          {email}
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}

/** The account the focused pane bills, updated when the host assigns or forgets it. */
export function ClaudePaneAccountBadge({ ptyId }: { ptyId: string }): React.JSX.Element | null {
  const assignments = useSyncExternalStore(
    subscribeClaudePaneAccounts,
    getClaudePaneAccountSnapshot,
    getClaudePaneAccountSnapshot
  )
  const assignment = assignments.get(ptyId)
  if (!assignment) {
    return null
  }
  return <ClaudePaneAccountChip label={assignment.label} email={assignment.email} />
}

/** Account chip and tab color, hidden while the title is being edited. */
export function ClaudePaneAccountMark({
  tabId,
  color,
  editing,
  nativeChat
}: {
  tabId: string
  color: string | null
  editing: boolean
  /** A Claude chat looks up the structured pane key. A terminal tab uses the focused PTY. */
  nativeChat?: NativeChatTabSession
}): React.JSX.Element | null {
  const ptyId = useFocusedTerminalPtyId(tabId)
  const sessionKey =
    nativeChat?.agent === 'claude'
      ? structuredAgentSessionPaneKey(
          structuredAgentSessionTabId(nativeChat.sessionId),
          nativeChat.sessionId
        )
      : null
  const accountKey = sessionKey || ptyId
  if (editing || (!accountKey && !color)) {
    return null
  }
  return (
    <>
      {accountKey ? <ClaudePaneAccountBadge ptyId={accountKey} /> : null}
      {color ? (
        <span className="mr-1.5 size-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
      ) : null}
    </>
  )
}
