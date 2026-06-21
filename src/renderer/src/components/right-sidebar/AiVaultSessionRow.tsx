import { useCallback } from 'react'
import type React from 'react'
import { Copy, FileJson, FolderOpen, Play } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
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
  AI_VAULT_SESSION_DRAG_START_EVENT,
  writeAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { SessionInlineDetails, SessionTime } from './AiVaultSessionDetails'
import { latestSessionConversationTurn } from './ai-vault-session-display'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'

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
}) {
  const updatedAt = session.updatedAt ?? session.modifiedAt
  const detailsId = getSessionDetailsId(session.id)
  const latestTurn = latestSessionConversationTurn(session)
  const detailsTooltip = detailsExpanded
    ? translate('auto.components.right.sidebar.AiVaultSessionRow.hideDetails', 'Hide Details')
    : translate('auto.components.right.sidebar.AiVaultSessionRow.showDetails', 'Show Details')
  const startResumeDrag = useCallback(
    (event: React.DragEvent<HTMLButtonElement>): void => {
      event.stopPropagation()
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
    },
    [resumeDisabled, session.agent, session.sessionId, session.title, resumeCommand]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild className="block w-full min-w-0">
        <div
          className="group/session-row flex min-h-[82px] w-full min-w-0 cursor-pointer flex-col border-b border-sidebar-border px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/55"
          onClick={() => {
            onToggleDetails()
          }}
        >
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
            <div
              className={cn(
                'min-w-0 text-[13px] font-medium leading-5 text-foreground',
                detailsExpanded ? 'break-words [overflow-wrap:anywhere]' : 'line-clamp-1'
              )}
            >
              {session.title}
            </div>
            <SessionRowTrailingActions
              session={session}
              detailsExpanded={detailsExpanded}
              detailsId={detailsId}
              detailsTooltip={detailsTooltip}
              resumeDisabled={resumeDisabled}
              onToggleDetails={onToggleDetails}
              onResume={onResume}
              onCopyResume={onCopyResume}
              onCopyId={onCopyId}
              onCopyPath={onCopyPath}
              onOpenLog={onOpenLog}
              onRevealLog={onRevealLog}
              onOpenCwd={onOpenCwd}
              onStartResumeDrag={startResumeDrag}
            />
          </div>
          <div className="mt-0.5 min-w-0 line-clamp-2 text-[12px] leading-4 text-muted-foreground">
            {latestTurn ? (
              <>
                <span className="font-medium text-foreground/80">
                  {conversationRoleLabel(latestTurn.role)}
                </span>
                <span>: {latestTurn.text}</span>
              </>
            ) : (
              translate(
                'auto.components.right.sidebar.AiVaultSessionRow.noPreviewAvailable',
                'No conversation preview available'
              )
            )}
          </div>
          <SessionMetadata session={session} updatedAt={updatedAt} />
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

export function SessionActionMenuItems({
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
}) {
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

function SessionMetadata({ session, updatedAt }: { session: AiVaultSession; updatedAt: string }) {
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
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
      <span className="shrink-0 text-muted-foreground/55">·</span>
      <SessionTime value={updatedAt} />
    </div>
  )
}

function conversationRoleLabel(role: AiVaultSession['previewMessages'][number]['role']): string {
  if (role === 'user') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.userRole', 'You')
  }
  if (role === 'assistant') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.agentRole', 'Agent')
  }
  if (role === 'tool') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.toolRole', 'Tool')
  }
  if (role === 'system') {
    return translate('auto.components.right.sidebar.AiVaultSessionRow.systemRole', 'System')
  }
  return translate('auto.components.right.sidebar.AiVaultSessionRow.sessionRole', 'Session')
}
