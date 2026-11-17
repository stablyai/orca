import React, { useId, useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  ReadSnapshotAgentStatus,
  ReadSnapshotSession
} from '../../../../../shared/cloud-workspaces/read-snapshot'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { agentStatusLabel } from './cloud-read-snapshot-format'

/** The app's agent names ("Claude", "Codex"); an id it does not know is shown as sent. */
function agentDisplayName(agent: string): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}

/** Messages shown before "Show more": enough to see where the agent left off. */
const COLLAPSED_MESSAGES = 2

const STATUS_TONE: Record<ReadSnapshotAgentStatus, string> = {
  working: 'text-foreground',
  attention: 'text-status-warning-text',
  idle: 'text-muted-foreground',
  unknown: 'text-muted-foreground'
}

function SessionCard({ session }: { session: ReadSnapshotSession }): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const listId = useId()
  const hidden = Math.max(0, session.messages.length - COLLAPSED_MESSAGES)
  const shown = expanded ? session.messages : session.messages.slice(-COLLAPSED_MESSAGES)
  const title =
    session.title ??
    session.messages.find((message) => message.role === 'user')?.text.slice(0, 80) ??
    t('components.orcaCloud.read.untitledChat', 'Untitled chat')
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      data-cloud-read-session=""
    >
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        {session.agent ? (
          <span className="shrink-0 text-muted-foreground">{agentDisplayName(session.agent)}</span>
        ) : null}
        <span className={cn('shrink-0', STATUS_TONE[session.status])}>
          {agentStatusLabel(session.status, session.turnOutcome, t)}
        </span>
      </div>
      {session.messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('components.orcaCloud.read.noMessages', 'No messages were saved for this chat.')}
        </p>
      ) : (
        <ol id={listId} className="flex flex-col gap-2">
          {shown.map((message) => (
            <li
              key={message.itemId}
              className={cn(
                'whitespace-pre-wrap break-words text-sm leading-relaxed',
                message.role === 'user'
                  ? 'ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-foreground'
                  : 'max-w-[95%] text-foreground/90'
              )}
            >
              <span className="sr-only">
                {message.role === 'user'
                  ? t('components.orcaCloud.read.roleUser', 'Person:')
                  : t('components.orcaCloud.read.roleAgent', 'Agent:')}{' '}
              </span>
              {message.text}
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 || session.truncated ? (
        <div className="flex items-center gap-2">
          {hidden > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDown
                className={cn(
                  'motion-safe:transition-transform motion-reduce:transition-none',
                  expanded && 'rotate-180'
                )}
                aria-hidden
              />
              {expanded
                ? t('components.orcaCloud.read.showLess', 'Show less')
                : t('components.orcaCloud.read.showMore', 'Show {{count}} earlier messages', {
                    count: hidden,
                    defaultValue_one: 'Show {{count}} earlier message'
                  })}
            </Button>
          ) : null}
          {session.truncated && (expanded || hidden === 0) ? (
            <span className="text-2xs text-muted-foreground">
              {t(
                'components.orcaCloud.read.truncated',
                'Older messages are in the workspace. Wake it to read them.'
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** Each agent chat as it was when the workspace went to sleep: agent, status and the tail. */
export function CloudReadSessions({
  sessions
}: {
  sessions: readonly ReadSnapshotSession[]
}): React.JSX.Element {
  const t = useTranslate()
  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('components.orcaCloud.read.noSessions', 'No agent chats were open.')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((session) => (
        <SessionCard key={session.sessionId} session={session} />
      ))}
    </ul>
  )
}
