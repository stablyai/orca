import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { ClaudeAccountSwitchPromptSessions } from '@/lib/provider-accounts/claude-account-switch-sessions'
import {
  isClaudePaneMidTurn,
  type ClaudeSessionCantMoveReason,
  type ClaudeSessionMoveCandidate
} from '@/lib/agent-session/accounts/claude/claude-session-account-move'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '../../../store/index'
import {
  AgentSessionRow,
  AgentSessionTree,
  type AgentSessionTreeGroup
} from '../../agent-session-restart/AgentSessionTree'

type SessionRowData = ClaudeSessionMoveCandidate & { reason?: string }

type SessionTreeProps = {
  selected: ReadonlySet<string>
  onToggle: (ptyId: string, checked: boolean) => void
}

export function ClaudeAccountSwitchSessionTree({
  sessions,
  previousAccountLabel,
  selected,
  onToggle
}: SessionTreeProps & {
  sessions: ClaudeAccountSwitchPromptSessions
  previousAccountLabel: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <AgentSessionTree
      label={t('accounts.claude.switchSessions.listLabel', 'Claude sessions to restart')}
      groups={sessionGroups(sessions, previousAccountLabel, t)}
      selected={selected}
      onToggle={onToggle}
      renderSession={(session, fixed) => (
        <SessionRow
          session={session}
          fixed={fixed}
          checked={selected.has(session.ptyId)}
          onToggle={onToggle}
        />
      )}
    />
  )
}

function sessionGroups(
  sessions: ClaudeAccountSwitchPromptSessions,
  previousAccountLabel: string,
  t: Translate = translate
): AgentSessionTreeGroup<SessionRowData>[] {
  const groups: AgentSessionTreeGroup<SessionRowData>[] = [
    {
      key: 'on-account',
      title: t('accounts.claude.switchSessions.groupOnAccount', 'Running on {{account}}', {
        account: previousAccountLabel
      }),
      sessions: sessions.onAccount
    },
    {
      key: 'elsewhere',
      title: t('accounts.claude.switchSessions.groupElsewhere', 'Not on {{account}}', {
        account: previousAccountLabel
      }),
      sessions: sessions.elsewhere.map((session) => ({ ...session, reason: session.accountLabel }))
    },
    {
      key: 'cant-move',
      title: t('accounts.claude.switchSessions.groupCantMove', "Can't move"),
      sessions: sessions.cantMove.map((session) => ({
        ...session,
        reason: cantMoveReasonLabel(session.reason, t)
      })),
      fixed: true
    }
  ]
  return groups.filter((group) => group.sessions.length > 0)
}

function cantMoveReasonLabel(
  reason: ClaudeSessionCantMoveReason,
  t: Translate = translate
): string {
  switch (reason) {
    case 'wsl-terminal':
      return t('accounts.claude.switchSessions.reasonWsl', 'WSL terminal')
    case 'own-folder':
      return t('accounts.claude.switchSessions.reasonOwnFolder', 'Uses your own Claude folder')
    case 'unknown-account':
      return t('accounts.claude.switchSessions.reasonUnknownAccount', 'Account unknown')
    case 'no-session':
      return t('accounts.claude.switchSessions.reasonNoSession', "Can't resume")
    case 'shared-session':
      return t('accounts.claude.switchSessions.reasonSharedSession', 'Also open in another pane')
  }
}

function SessionRow({
  session,
  fixed,
  checked,
  onToggle
}: Pick<SessionTreeProps, 'onToggle'> & {
  session: SessionRowData
  fixed: boolean
  checked: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const busy = useAppStore((store) =>
    isClaudePaneMidTurn(store, makePaneKey(session.tabId, session.leafId))
  )
  return (
    <AgentSessionRow
      session={session}
      agent="claude"
      fallbackTitle={t('accounts.claude.switchSessions.session', 'Claude session')}
      busy={busy}
      reason={session.reason}
      fixed={fixed}
      checked={checked}
      onToggle={onToggle}
    />
  )
}
