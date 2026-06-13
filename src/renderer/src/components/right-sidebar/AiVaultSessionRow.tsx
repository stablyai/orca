import type React from 'react'
import { Copy, FileJson, FolderOpen, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardTrigger } from '@/components/ui/hover-card'
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
import {
  formatTokenCount,
  MetaDot,
  SessionActionsMenu,
  SessionDetailsHoverCard,
  SessionTime
} from './AiVaultSessionDetails'

export function VaultSessionRow({
  session,
  resumeCommand,
  resumeDisabled,
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
  resumeDisabled: boolean
  onResume: () => void
  onCopyResume: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog: () => void
  onRevealLog: () => void
  onOpenCwd?: () => void
}): React.JSX.Element {
  const updatedAt = session.updatedAt ?? session.modifiedAt

  return (
    <HoverCard openDelay={350} closeDelay={80}>
      <ContextMenu>
        <HoverCardTrigger asChild>
          <ContextMenuTrigger asChild>
            <div
              draggable={!resumeDisabled}
              className={cn(
                'group relative flex min-h-[64px] w-full items-start border-b border-sidebar-border px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/55',
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
              <div className="min-w-0 flex-1 pr-16">
                <div className="truncate text-[13px] font-medium leading-5 text-foreground">
                  {session.title}
                </div>
                <SessionMetadata session={session} />
              </div>
              <SessionTime
                value={updatedAt}
                className="absolute right-3 top-2 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
              />
              <div className="pointer-events-none absolute right-2 top-1.5 flex items-center gap-1 rounded-md bg-sidebar/95 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
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
                  onClick={(event) => {
                    event.stopPropagation()
                    onResume()
                  }}
                >
                  <Play className="size-3.5" />
                </Button>
                <SessionActionsMenu
                  session={session}
                  onResume={onResume}
                  onCopyResume={onCopyResume}
                  onCopyId={onCopyId}
                  onCopyPath={onCopyPath}
                  onOpenLog={onOpenLog}
                  onRevealLog={onRevealLog}
                  onOpenCwd={onOpenCwd}
                  resumeDisabled={resumeDisabled}
                />
              </div>
            </div>
          </ContextMenuTrigger>
        </HoverCardTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={resumeDisabled} onSelect={onResume}>
            <Play className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewTab',
              'Resume in New Tab'
            )}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCopyResume}>
            <Copy className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.copyResumeCommand',
              'Copy Resume Command'
            )}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onOpenLog}>
            <FileJson className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultSessionRow.openLog', 'Open Log')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRevealLog}>
            <FolderOpen className="size-3.5" />
            {translate('auto.components.right.sidebar.AiVaultSessionRow.revealLog', 'Reveal Log')}
          </ContextMenuItem>
          {onOpenCwd ? (
            <ContextMenuItem onSelect={onOpenCwd}>
              <FolderOpen className="size-3.5" />
              {translate(
                'auto.components.right.sidebar.AiVaultSessionRow.openWorkingDirectory',
                'Open Working Directory'
              )}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onCopyId}>
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.copySessionId',
              'Copy Session ID'
            )}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCopyPath}>
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.copyLogPath',
              'Copy Log Path'
            )}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <SessionDetailsHoverCard session={session} resumeCommand={resumeCommand} />
    </HoverCard>
  )
}

function SessionMetadata({ session }: { session: AiVaultSession }): React.JSX.Element {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <AgentIcon agent={session.agent} size={14} />
      </span>
      {session.model ? (
        <>
          <MetaDot />
          <span className="max-w-[92px] truncate">{session.model}</span>
        </>
      ) : null}
      {session.branch ? (
        <>
          <MetaDot />
          <span className="min-w-0 truncate text-muted-foreground/85">{session.branch}</span>
        </>
      ) : null}
      <MetaDot />
      <span className="shrink-0">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.messageCount',
          '{{value0}} msgs',
          { value0: session.messageCount }
        )}
      </span>
      {session.totalTokens > 0 ? (
        <>
          <MetaDot />
          <span className="shrink-0">
            {translate(
              'auto.components.right.sidebar.AiVaultSessionRow.tokenCount',
              '{{value0}} tok',
              { value0: formatTokenCount(session.totalTokens) }
            )}
          </span>
        </>
      ) : null}
    </div>
  )
}
