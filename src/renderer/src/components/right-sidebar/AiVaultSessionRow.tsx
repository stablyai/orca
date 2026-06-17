import type React from 'react'
import { ChevronDown, Copy, FileJson, FolderOpen, MoreHorizontal, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import {
  AI_VAULT_SESSION_DRAG_END_EVENT,
  AI_VAULT_SESSION_DRAG_START_EVENT,
  writeAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { SessionInlineDetails, SessionTime } from './AiVaultSessionDetails'

export function VaultSessionRow({
  session,
  resumeCommand,
  detailsExpanded,
  resumeDisabled,
  onToggleDetails,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  session: AiVaultSession
  resumeCommand: string
  detailsExpanded: boolean
  resumeDisabled: boolean
  onToggleDetails: () => void
  onResume: () => void
  onCopyResume: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog: () => void
  onRevealLog: () => void
  onOpenCwd?: () => void
}): React.JSX.Element {
  const updatedAt = session.updatedAt ?? session.modifiedAt
  const detailsId = getSessionDetailsId(session.id)
  const detailsTooltip = detailsExpanded
    ? translate('auto.components.right.sidebar.AiVaultSessionRow.hideDetails', 'Hide Details')
    : translate('auto.components.right.sidebar.AiVaultSessionRow.showDetails', 'Show Details')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          draggable={!resumeDisabled}
          className={cn(
            'group relative flex min-h-[64px] w-full flex-col border-b border-sidebar-border px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/55',
            !resumeDisabled && 'cursor-grab active:cursor-grabbing'
          )}
          onDragStart={(event) => {
            if (resumeDisabled) {
              event.preventDefault()
              return
            }
            writeAiVaultSessionDragData(event.dataTransfer, {
              agent: session.agent,
              sessionId: session.sessionId,
              title: session.title,
              command: resumeCommand
            })
            window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_START_EVENT))
          }}
          onDragEnd={() => {
            window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_END_EVENT))
          }}
          onDoubleClick={() => {
            if (!resumeDisabled) {
              onResume()
            }
          }}
        >
          <div className="min-w-0 flex-1 pr-24">
            <div className="flex min-w-0 items-start gap-1.5">
              <div className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground">
                {session.title}
              </div>
              <SessionTime value={updatedAt} className="mt-0.5 @max-[300px]/ai-vault:hidden" />
            </div>
            <SessionMetadata session={session} />
          </div>
          <div
            className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-1 rounded-md bg-sidebar/95"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeAgentSession',
                    'Resume {{value0}} session',
                    { value0: agentLabel(session.agent) }
                  )}
                  disabled={resumeDisabled}
                  draggable={false}
                  onClick={(event) => {
                    event.stopPropagation()
                    onResume()
                  }}
                  // Why: the wrapper is `pointer-events-none`; this control only
                  // re-enables pointer events on hover/focus. On touch (no hover)
                  // it is visible via `can-hover:opacity-0`, so it must also be
                  // tappable — keep base `pointer-events-auto` and only disable it
                  // on hover-capable devices where the reveal gates interaction.
                  className="pointer-events-auto can-hover:pointer-events-none can-hover:opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                >
                  <Play className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewTab',
                  'Resume in New Tab'
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.toggleSessionDetails',
                    '{{value0}} session details',
                    { value0: agentLabel(session.agent) }
                  )}
                  aria-expanded={detailsExpanded}
                  aria-controls={detailsId}
                  draggable={false}
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleDetails()
                  }}
                  className="pointer-events-auto"
                >
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', detailsExpanded && 'rotate-180')}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {detailsTooltip}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate(
                        'auto.components.right.sidebar.AiVaultSessionRow.moreSessionActions',
                        'More Session Actions'
                      )}
                      draggable={false}
                      className="pointer-events-auto"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.moreActions',
                    'More Actions'
                  )}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <SessionActionMenuItems
                  resumeDisabled={resumeDisabled}
                  onResume={onResume}
                  onCopyResume={onCopyResume}
                  onCopyId={onCopyId}
                  onCopyPath={onCopyPath}
                  onOpenLog={onOpenLog}
                  onRevealLog={onRevealLog}
                  onOpenCwd={onOpenCwd}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {detailsExpanded ? (
            <SessionInlineDetails
              id={detailsId}
              session={session}
              resumeDisabled={resumeDisabled}
              onResume={onResume}
              onCopyResume={onCopyResume}
            />
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionActionMenuItems
          menuKind="context"
          resumeDisabled={resumeDisabled}
          onResume={onResume}
          onCopyResume={onCopyResume}
          onCopyId={onCopyId}
          onCopyPath={onCopyPath}
          onOpenLog={onOpenLog}
          onRevealLog={onRevealLog}
          onOpenCwd={onOpenCwd}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SessionActionMenuItems({
  menuKind = 'dropdown',
  resumeDisabled,
  onResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  menuKind?: 'dropdown' | 'context'
  resumeDisabled: boolean
  onResume: () => void
  onCopyResume: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog: () => void
  onRevealLog: () => void
  onOpenCwd?: () => void
}): React.JSX.Element {
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = menuKind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator

  return (
    <>
      <Item disabled={resumeDisabled} onSelect={onResume}>
        <Play className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewTab',
          'Resume in New Tab'
        )}
      </Item>
      <Item onSelect={onCopyResume}>
        <Copy className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.copyResumeCommand',
          'Copy Resume Command'
        )}
      </Item>
      <Separator />
      <Item onSelect={onOpenLog}>
        <FileJson className="size-3.5" />
        {translate('auto.components.right.sidebar.AiVaultSessionRow.openLog', 'Open Log')}
      </Item>
      <Item onSelect={onRevealLog}>
        <FolderOpen className="size-3.5" />
        {translate('auto.components.right.sidebar.AiVaultSessionRow.revealLog', 'Reveal Log')}
      </Item>
      {onOpenCwd ? (
        <Item onSelect={onOpenCwd}>
          <FolderOpen className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.openWorkingDirectory',
            'Open Working Directory'
          )}
        </Item>
      ) : null}
      <Separator />
      <Item onSelect={onCopyId}>
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.copySessionId',
          'Copy Session ID'
        )}
      </Item>
      <Item onSelect={onCopyPath}>
        {translate('auto.components.right.sidebar.AiVaultSessionRow.copyLogPath', 'Copy Log Path')}
      </Item>
    </>
  )
}

function getSessionDetailsId(sessionId: string): string {
  return `ai-vault-session-details-${sessionId.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function SessionMetadata({ session }: { session: AiVaultSession }): React.JSX.Element {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <AgentIcon agent={session.agent} size={14} />
      </span>
      <span className="min-w-0 truncate">{agentLabel(session.agent)}</span>
      <span className="shrink-0 rounded-sm border border-sidebar-border bg-sidebar-accent/45 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.messageCount',
          '{{value0}} msgs',
          { value0: session.messageCount }
        )}
      </span>
    </div>
  )
}
