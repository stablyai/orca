import { useCallback } from 'react'
import type React from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import {
  AI_VAULT_SESSION_DRAG_END_EVENT,
  AI_VAULT_SESSION_DRAG_START_EVENT,
  writeAiVaultSessionDragData
} from '@/lib/ai-vault-session-drag'
import type { AiVaultScope, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import { translate } from '@/i18n/i18n'
import { SessionInlineDetails } from './AiVaultSessionDetails'
import { latestSessionConversationTurn } from './ai-vault-session-display'
import { SessionActionMenuItems } from './AiVaultSessionActionMenuItems'
import { SessionRowTrailingActions } from './SessionRowTrailingActions'
import type { AiVaultSessionResumeActions } from './ai-vault-session-resume'
import {
  shouldShowAiVaultSessionWorktreeLine,
  type AiVaultSessionWorktreeInfo
} from './ai-vault-session-worktree'
import {
  conversationRoleLabel,
  getSessionDetailsId,
  SessionMetadata,
  SessionWorktreeLine
} from './ai-vault-session-row-display'
import type { AgentStatusState } from '../../../../shared/agent-status-types'

export function VaultSessionRow({
  session,
  liveState,
  resumeStartup,
  realHomeResumeStartup,
  worktreeInfo,
  vaultScope,
  detailsExpanded,
  resumeDisabled,
  onToggleDetails,
  onJumpToOriginalPane,
  showJumpToWorktree,
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
  liveState: AgentStatusState | null
  resumeStartup: AiVaultResumeStartup
  realHomeResumeStartup: AiVaultResumeStartup
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  vaultScope: AiVaultScope
  detailsExpanded: boolean
  resumeDisabled: boolean
  onToggleDetails: () => void
  onJumpToOriginalPane?: () => void
  showJumpToWorktree: boolean
  onJumpToWorktree?: () => void
  onResume: () => void
  resumeLabel: string
  resumeActions: AiVaultSessionResumeActions
  onResumeInWorktree: () => void
  onResumeInNewTab: () => void
  onCopyResume?: () => void
  onCopyId: () => void
  onCopyPath: () => void
  onOpenLog?: () => void
  onRevealLog?: () => void
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
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        codexHome: session.codexHome,
        ...(resumeStartup.env ? { env: resumeStartup.env } : {}),
        ...(resumeStartup.envToDelete ? { envToDelete: resumeStartup.envToDelete } : {}),
        ...(resumeStartup.launchConfig ? { launchConfig: resumeStartup.launchConfig } : {}),
        realHomeStartup: realHomeResumeStartup
      })
      window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_START_EVENT))
    },
    [realHomeResumeStartup, resumeDisabled, session, resumeStartup]
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
              showJumpToWorktree={showJumpToWorktree}
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
          {detailsExpanded && shouldShowAiVaultSessionWorktreeLine(worktreeInfo, { vaultScope }) ? (
            <div className="mt-1">
              <SessionWorktreeLine worktreeInfo={worktreeInfo} vaultScope={vaultScope} />
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
                liveState={liveState}
                updatedAt={updatedAt}
                worktreeInfo={worktreeInfo}
                vaultScope={vaultScope}
              />
            </>
          ) : null}
          {detailsExpanded ? (
            <SessionInlineDetails
              id={detailsId}
              session={session}
              worktreeInfo={worktreeInfo}
              vaultScope={vaultScope}
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
          showJumpToWorktree={showJumpToWorktree}
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
