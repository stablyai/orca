import type React from 'react'
import { Copy, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { recentSessionConversationTurns } from './ai-vault-session-display'

export function SessionInlineDetails({
  id,
  session,
  onResume,
  onCopyResume,
  resumeDisabled
}: {
  id: string
  session: AiVaultSession
  onResume: () => void
  onCopyResume: () => void
  resumeDisabled: boolean
}): React.JSX.Element {
  const updatedAt = session.updatedAt ?? session.modifiedAt
  const recentTurns = recentSessionConversationTurns(session, 3)

  return (
    <div
      id={id}
      className="mt-2 rounded-md border border-sidebar-border bg-sidebar-accent/25 p-2.5"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div className="space-y-2.5">
        <SessionReceiptSection
          label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.originalAsk',
            'Original ask'
          )}
        >
          <div className="min-w-0 break-words text-[12px] font-medium leading-4 text-foreground [overflow-wrap:anywhere]">
            {session.title}
          </div>
        </SessionReceiptSection>

        <SessionReceiptSection
          label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.latestTurns',
            'Latest turns'
          )}
        >
          {recentTurns.length > 0 ? (
            <div className="grid gap-1.5">
              {recentTurns.map((turn, index) => (
                <div
                  key={`${turn.timestamp ?? 'turn'}-${index}`}
                  className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] gap-2 text-[11px] leading-4"
                >
                  <span className="text-muted-foreground">{conversationRoleLabel(turn.role)}</span>
                  <span className="line-clamp-3 text-foreground/90">{turn.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.noPreviewAvailable',
                'No conversation preview available'
              )}
            </div>
          )}
        </SessionReceiptSection>

        <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <AgentIcon agent={session.agent} size={14} />
          </span>
          <span className="min-w-0 truncate">{agentLabel(session.agent)}</span>
          <span className="shrink-0 text-muted-foreground/55">·</span>
          <span className="shrink-0">
            {translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.messageCount',
              '{{value0}} msgs',
              { value0: session.messageCount }
            )}
          </span>
          <span className="shrink-0 text-muted-foreground/55">·</span>
          <SessionTime value={updatedAt} />
        </div>
      </div>

      <div className="mt-2 grid gap-1">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          disabled={resumeDisabled}
          draggable={false}
          onClick={(event) => {
            event.stopPropagation()
            onResume()
          }}
          className="h-7 justify-start px-2 text-[11px]"
        >
          <Play className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.resumeInNewTab',
            'Resume in New Tab'
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          draggable={false}
          onClick={(event) => {
            event.stopPropagation()
            onCopyResume()
          }}
          className="h-7 justify-start px-2 text-[11px]"
        >
          <Copy className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copyResumeCommand',
            'Copy Resume Command'
          )}
        </Button>
      </div>
    </div>
  )
}

function SessionReceiptSection({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="text-[10px] font-semibold uppercase leading-3 text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

export function SessionTime({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return (
      <span className={cn('shrink-0 text-[11px] text-muted-foreground', className)}>
        {translate(
          'auto.components.right.sidebar.AiVaultSessionDetails.unknownTime',
          'Unknown time'
        )}
      </span>
    )
  }

  const date = new Date(timestamp)
  return (
    <span className={cn('shrink-0 text-[11px] text-muted-foreground', className)}>
      <time dateTime={date.toISOString()}>{formatTimeAgo(timestamp)}</time>
    </span>
  )
}

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  if (diffMs < 60_000) {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.justNow', 'Just now')
  }
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionDetails.minutesAgo',
      '{{value0}}m ago',
      { value0: minutes }
    )
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionDetails.hoursAgo',
      '{{value0}}h ago',
      { value0: hours }
    )
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionDetails.daysAgo',
      '{{value0}}d ago',
      { value0: days }
    )
  }
  const months = Math.floor(days / 30)
  if (months < 12) {
    return translate(
      'auto.components.right.sidebar.AiVaultSessionDetails.monthsAgo',
      '{{value0}}mo ago',
      { value0: months }
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultSessionDetails.yearsAgo',
    '{{value0}}y ago',
    { value0: Math.floor(months / 12) }
  )
}

function conversationRoleLabel(role: AiVaultSession['previewMessages'][number]['role']): string {
  if (role === 'user') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.userRole', 'You')
  }
  if (role === 'assistant') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.agentRole', 'Agent')
  }
  if (role === 'tool') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.toolRole', 'Tool')
  }
  if (role === 'system') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.systemRole', 'System')
  }
  return translate('auto.components.right.sidebar.AiVaultSessionDetails.sessionRole', 'Session')
}
