import type React from 'react'
import { useCallback } from 'react'
import { Copy, FileJson, FolderOpen, MoreHorizontal, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { HoverCardContent } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'

export function SessionDetailsHoverCard({
  session,
  resumeCommand
}: {
  session: AiVaultSession
  resumeCommand: string
}): React.JSX.Element {
  const updatedAt = session.updatedAt ?? session.modifiedAt

  return (
    <HoverCardContent
      side="left"
      align="start"
      sideOffset={8}
      className="scrollbar-sleek max-h-[min(28rem,calc(100vh-2rem))] w-80 overflow-y-auto p-3"
    >
      <div className="min-w-0">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <AgentIcon agent={session.agent} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-medium leading-5 text-popover-foreground">
              {session.title}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {agentLabel(session.agent)}
            </div>
          </div>
        </div>

        <TooltipProvider delayDuration={300}>
          <div className="mt-3 space-y-1.5 text-[11px] leading-4">
            <DetailLine
              label={translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.updated',
                'Updated'
              )}
              value={formatDateTime(updatedAt)}
            />
            <DetailLine
              label={translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.created',
                'Created'
              )}
              value={formatDateTime(session.createdAt)}
            />
            {session.branch ? (
              <DetailLine
                label={translate(
                  'auto.components.right.sidebar.AiVaultSessionDetails.branch',
                  'Branch'
                )}
                value={session.branch}
              />
            ) : null}
            {session.model ? (
              <DetailLine
                label={translate(
                  'auto.components.right.sidebar.AiVaultSessionDetails.model',
                  'Model'
                )}
                value={session.model}
              />
            ) : null}
            <DetailLine
              label={translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.usage',
                'Usage'
              )}
              value={translate(
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
              )}
            />
            <DetailLine
              label={translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.session',
                'Session'
              )}
              value={session.sessionId}
              mono
            />
          </div>
        </TooltipProvider>

        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.latestLog',
              'Latest log'
            )}
          </div>
          {session.previewMessages.length > 0 ? (
            <div className="space-y-2">
              {session.previewMessages.map((message, index) => (
                <div key={`${message.role}:${index}`} className="min-w-0">
                  <div className="mb-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                    {previewRoleLabel(message.role)}
                  </div>
                  <div className="line-clamp-3 whitespace-pre-wrap text-[11px] leading-4 text-popover-foreground/90">
                    {message.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.AiVaultSessionDetails.noReadablePreview',
                'No readable message preview in this transcript.'
              )}
            </div>
          )}
        </div>

        <div className="mt-3 border-t border-border/60 pt-2">
          <div className="mb-1 text-[11px] font-semibold text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.resumeCommand',
              'Resume command'
            )}
          </div>
          <div className="line-clamp-3 break-all font-mono text-[10.5px] leading-4 text-popover-foreground/85">
            {resumeCommand}
          </div>
        </div>
      </div>
    </HoverCardContent>
  )
}

function DetailLine({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  const handleCopy = useCallback(() => {
    void window.api.ui.writeClipboardText(value).then(() => {
      toast.success(
        translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
          value0: label
        })
      )
    })
  }, [label, value])

  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              'min-w-0 truncate text-left text-popover-foreground/90 transition-colors hover:text-popover-foreground',
              mono && 'font-mono'
            )}
            aria-label={translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.copyDetailValue',
              'Copy {{value0}}',
              { value0: label }
            )}
          >
            {value}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          sideOffset={4}
          className="pointer-events-none max-w-[min(20rem,calc(100vw-2rem))] break-all"
        >
          {value}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export function MetaDot(): React.JSX.Element {
  return <span className="shrink-0 text-muted-foreground/45">·</span>
}

export function SessionActionsMenu({
  session,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  resumeDisabled
}: {
  session: AiVaultSession
  onResume: () => void
  onCopyResume: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog: () => void
  onRevealLog: () => void
  onOpenCwd?: () => void
  resumeDisabled: boolean
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.sessionActions',
            '{{value0}} session actions',
            { value0: agentLabel(session.agent) }
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={resumeDisabled} onSelect={onResume}>
          <Play className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.resumeInNewTab',
            'Resume in New Tab'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyResume}>
          <Copy className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copyResumeCommand',
            'Copy Resume Command'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenLog}>
          <FileJson className="size-3.5" />
          {translate('auto.components.right.sidebar.AiVaultSessionDetails.openLog', 'Open Log')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRevealLog}>
          <FolderOpen className="size-3.5" />
          {translate('auto.components.right.sidebar.AiVaultSessionDetails.revealLog', 'Reveal Log')}
        </DropdownMenuItem>
        {onOpenCwd ? (
          <DropdownMenuItem onSelect={onOpenCwd}>
            <FolderOpen className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.openWorkingDirectory',
              'Open Working Directory'
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopyId}>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copySessionId',
            'Copy Session ID'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPath}>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.copyLogPath',
            'Copy Log Path'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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

function previewRoleLabel(role: AiVaultSession['previewMessages'][number]['role']): string {
  if (role === 'user') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.user', 'User')
  }
  if (role === 'assistant') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.assistant', 'Assistant')
  }
  if (role === 'tool') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.tool', 'Tool')
  }
  if (role === 'system') {
    return translate('auto.components.right.sidebar.AiVaultSessionDetails.system', 'System')
  }
  return translate('auto.components.right.sidebar.AiVaultSessionDetails.log', 'Log')
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
