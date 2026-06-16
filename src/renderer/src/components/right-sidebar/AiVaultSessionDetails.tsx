import type React from 'react'
import { Copy, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'

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
  const usage = translate(
    'auto.components.right.sidebar.AiVaultSessionDetails.usageValue',
    '{{value0}} msgs{{value1}}',
    {
      value0: session.messageCount,
      value1:
        session.totalTokens > 0
          ? translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.tokenSuffix',
              ' · {{value0}} tok',
              { value0: formatTokenCount(session.totalTokens) }
            )
          : ''
    }
  )

  return (
    <div
      id={id}
      className="mt-2 rounded-md border border-sidebar-border bg-sidebar-accent/25 p-2"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <AgentIcon agent={session.agent} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[12px] font-medium leading-4 text-foreground">
            {session.title}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {agentLabel(session.agent)}
          </div>
        </div>
      </div>

      <div className="mt-2 grid gap-1 text-[11px] leading-4">
        <SessionDetailCopyRow
          label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.updated',
            'Updated'
          )}
          value={formatDateTime(updatedAt)}
        />
        <SessionDetailCopyRow
          label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.created',
            'Created'
          )}
          value={formatDateTime(session.createdAt)}
        />
        {session.model ? (
          <SessionDetailCopyRow
            label={translate('auto.components.right.sidebar.AiVaultSessionDetails.model', 'Model')}
            value={session.model}
          />
        ) : null}
        {session.branch ? (
          <SessionDetailCopyRow
            label={translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.branch',
              'Branch'
            )}
            value={session.branch}
          />
        ) : null}
        <SessionDetailCopyRow
          label={translate('auto.components.right.sidebar.AiVaultSessionDetails.usage', 'Usage')}
          value={usage}
        />
        <SessionDetailCopyRow
          label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.session',
            'Session'
          )}
          copyLabel={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.sessionId',
            'Session ID'
          )}
          value={session.sessionId}
          mono
        />
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

function SessionDetailCopyRow({
  label,
  copyLabel = label,
  value,
  mono = false
}: {
  label: string
  copyLabel?: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    void window.api.ui
      .writeClipboardText(value)
      .then(() => {
        toast.success(
          translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
            value0: copyLabel
          })
        )
      })
      .catch(() => {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.valueCopyFailed',
            'Unable to copy {{value0}}',
            { value0: copyLabel }
          )
        )
      })
  }

  return (
    <div className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-sm px-1 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-foreground/90', mono && 'font-mono')}>
        {value}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            draggable={false}
            onClick={handleCopy}
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.copyDetailValue',
              'Copy {{value0}}',
              { value0: copyLabel }
            )}
            className="size-5 text-muted-foreground hover:text-foreground"
          >
            <Copy className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copyDetailValue',
            'Copy {{value0}}',
            { value0: copyLabel }
          )}
        </TooltipContent>
      </Tooltip>
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

function formatDateTime(value: string | null): string {
  if (!value) {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.unknown', 'Unknown')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.unknown', 'Unknown')
  }
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
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

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }
  return String(value)
}
