import { useCallback } from 'react'
import type React from 'react'
import { Copy, FileJson, FolderOpen, LocateFixed, PanelTopOpen, Play } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { useRepoById } from '@/store/selectors'
import { resolveRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'
import {
  AI_VAULT_SESSION_DRAG_END_EVENT,
  AI_VAULT_SESSION_DRAG_START_EVENT,
  writeAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { agentLabel } from './ai-vault-session-filters'
import { translate } from '@/i18n/i18n'
import { SessionInlineDetails, SessionTime } from './AiVaultSessionDetails'
import { latestSessionConversationTurn } from './ai-vault-session-display'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'
import type { AiVaultSessionResumeActions } from './ai-vault-session-resume'
import {
  aiVaultWorktreeStatusLabel,
  shouldShowAiVaultWorktreeStatusBadge,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'

export function VaultSessionRow({
  session,
  resumeStartup,
  worktreeInfo,
  detailsExpanded,
  resumeDisabled,
  onToggleDetails,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  resumeLabel,
  resumeActions,
  onResumeInWorktree,
  onResumeInNewTab,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  session: AiVaultSession
  resumeStartup: AiVaultResumeStartup
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  detailsExpanded: boolean
  resumeDisabled: boolean
  onToggleDetails: () => void
  onJumpToOriginalPane?: () => void
  onJumpToWorktree?: () => void
  onResume: () => void
  resumeLabel: string
  resumeActions: AiVaultSessionResumeActions
  onResumeInWorktree: () => void
  onResumeInNewTab: () => void
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
    (event: React.DragEvent<HTMLElement>): void => {
      event.stopPropagation()
      const target = event.target
      if (target instanceof Element && target.closest('[data-ai-vault-session-actions]')) {
        event.preventDefault()
        return
      }
      if (resumeDisabled) {
        event.preventDefault()
        return
      }
      writeAiVaultSessionDragData(event.dataTransfer, {
        agent: session.agent,
        sessionId: session.sessionId,
        title: session.title,
        command: resumeStartup.command,
        ...(resumeStartup.env ? { env: resumeStartup.env } : {}),
        ...(resumeStartup.launchConfig ? { launchConfig: resumeStartup.launchConfig } : {})
      })
      window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_START_EVENT))
    },
    [resumeDisabled, session.agent, session.sessionId, session.title, resumeStartup]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild className="block w-full min-w-0">
        <div
          className={cn(
            'group/session-row flex w-full min-w-0 flex-col border-b border-sidebar-border px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/55',
            resumeDisabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
            !detailsExpanded && 'min-h-[98px]'
          )}
          // Why: users naturally drag the session row itself; matching that
          // gesture avoids hidden affordances and text-selection false starts.
          draggable={!resumeDisabled}
          onClick={() => {
            onToggleDetails()
          }}
          onDragStart={startResumeDrag}
          onDragEnd={() => {
            window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_END_EVENT))
          }}
        >
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
            <div
              className={cn(
                'min-w-0 text-[13px] font-medium leading-5 text-foreground',
                detailsExpanded ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'line-clamp-1'
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
              resumeLabel={resumeLabel}
              worktreeInfo={worktreeInfo}
              onToggleDetails={onToggleDetails}
              onJumpToOriginalPane={onJumpToOriginalPane}
              onJumpToWorktree={onJumpToWorktree}
              onResume={onResume}
              onCopyResume={onCopyResume}
              onCopyId={onCopyId}
              onCopyPath={onCopyPath}
              onOpenLog={onOpenLog}
              onRevealLog={onRevealLog}
              onOpenCwd={onOpenCwd}
            />
          </div>
          {detailsExpanded && worktreeInfo ? (
            <div className="mt-1">
              <SessionWorktreeLine worktreeInfo={worktreeInfo} />
            </div>
          ) : null}
          {!detailsExpanded ? (
            <>
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
              <SessionMetadata
                session={session}
                updatedAt={updatedAt}
                worktreeInfo={worktreeInfo}
              />
            </>
          ) : null}
          {detailsExpanded ? (
            <SessionInlineDetails
              id={detailsId}
              session={session}
              worktreeInfo={worktreeInfo}
              resumeActions={resumeActions}
              onResumeInWorktree={onResumeInWorktree}
              onResumeInNewTab={onResumeInNewTab}
              onOpenLog={onOpenLog}
            />
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionActionMenuItems
          menuKind="context"
          resumeDisabled={resumeDisabled}
          resumeLabel={resumeLabel}
          onJumpToOriginalPane={onJumpToOriginalPane}
          onJumpToWorktree={onJumpToWorktree}
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
  resumeLabel,
  onResume,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd
}: {
  menuKind?: 'dropdown' | 'context'
  resumeDisabled: boolean
  resumeLabel: string
  onResume: () => void
  onJumpToOriginalPane?: () => void
  onJumpToWorktree?: () => void
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
      {onJumpToOriginalPane ? (
        <Item onSelect={onJumpToOriginalPane}>
          <LocateFixed className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.jumpToOriginalPane',
            'Jump to Original Pane'
          )}
        </Item>
      ) : null}
      <Item disabled={!onJumpToWorktree} onSelect={onJumpToWorktree}>
        <PanelTopOpen className="size-3.5" />
        {translate(
          'auto.components.right.sidebar.AiVaultSessionRow.jumpToWorktree',
          'Jump to Worktree'
        )}
      </Item>
      <Item disabled={resumeDisabled} onSelect={onResume}>
        <Play className="size-3.5" />
        {resumeLabel}
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

function SessionMetadata({
  session,
  updatedAt,
  worktreeInfo
}: {
  session: AiVaultSession
  updatedAt: string
  worktreeInfo: AiVaultSessionWorktreeInfo | null
}) {
  return (
    <div className="mt-1 grid min-w-0 gap-0.5 text-[11px] leading-4 text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <AgentIcon agent={session.agent} size={14} />
        </span>
        <span className="min-w-0 truncate">{agentLabel(session.agent)}</span>
        <span className="shrink-0 tabular-nums">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.messageCount',
            '{{value0}} msgs',
            { value0: session.messageCount }
          )}
        </span>
        <span className="shrink-0 text-muted-foreground/55">·</span>
        <SessionTime value={updatedAt} />
      </div>
      {worktreeInfo ? <SessionWorktreeLine worktreeInfo={worktreeInfo} /> : null}
    </div>
  )
}

function SessionWorktreeLine({
  worktreeInfo
}: {
  worktreeInfo: AiVaultSessionWorktreeInfo
}): React.JSX.Element {
  const repoId = worktreeInfo.worktreeId
    ? (splitWorktreeIdForFilesystem(worktreeInfo.worktreeId)?.repoId ?? null)
    : null
  const repo = useRepoById(repoId)

  return (
    <div className="flex min-w-0 items-center gap-1.5 pl-5">
      {shouldShowAiVaultWorktreeStatusBadge(worktreeInfo.status) ? (
        <span className="shrink-0 rounded-sm border border-sidebar-border bg-sidebar-accent/45 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          {worktreeStatusLabel(worktreeInfo.status)}
        </span>
      ) : null}
      <Badge
        variant="outline"
        className="h-5 max-w-full gap-1 border-border/70 bg-background px-1.5 py-0 text-[11px] font-medium"
        title={worktreeInfo.label}
      >
        <RepoBadgeLabel
          name={worktreeInfo.label}
          color={resolveRepoBadgeColor(repo?.badgeColor)}
          className="min-w-0 max-w-full"
          badgeClassName="size-1.5"
        />
      </Badge>
    </div>
  )
}

function worktreeStatusLabel(status: AiVaultSessionWorktreeInfo['status']): string {
  return aiVaultWorktreeStatusLabel(status)
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
