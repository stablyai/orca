import { isAntigravityReferenceSession } from '../../../../shared/antigravity-session-origin'
import type { AiVaultSubagentResumeActions } from './AiVaultSessionSubagents'
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
import { aiVaultSessionDeleteBlockedReason } from './ai-vault-session-deletability'
import type { AiVaultSessionResumeActions } from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'
import {
  conversationRoleLabel,
  getSessionDetailsId,
  SessionMetadata
} from './ai-vault-session-row-display'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSearchHit } from '../../../../shared/ai-vault-search-types'
import { AiVaultSearchEvidence } from './AiVaultSearchEvidence'
import { useAiVaultSessionDisplayTitle } from './use-ai-vault-session-display-title'

export function VaultSessionRow({
  session,
  liveState,
  resumeStartup,
  realHomeResumeStartup,
  worktreeInfo,
  vaultScope,
  detailsExpanded,
  resumeDisabled,
  resumeHidden,
  onToggleDetails,
  onJumpToOriginalPane,
  showJumpToWorktree,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onResumeInNewChat,
  onResumeInNewCli,
  resumeLabel: defaultResumeLabel,
  resumeActions,
  onResumeInWorktree,
  onResumeInNewTab,
  subagentResume,
  onCopyResume,
  onCopyId,
  onCopyPath,
  onOpenLog,
  onRevealLog,
  onOpenCwd,
  onRequestDelete,
  searchHit,
  onPick
}: {
  session: AiVaultSession
  liveState: AgentStatusState | null
  resumeStartup: AiVaultResumeStartup
  realHomeResumeStartup: AiVaultResumeStartup
  worktreeInfo: AiVaultSessionWorktreeInfo | null
  vaultScope: AiVaultScope
  detailsExpanded: boolean
  resumeDisabled: boolean
  resumeHidden?: boolean
  onToggleDetails: () => void
  onJumpToOriginalPane?: () => void
  showJumpToWorktree: boolean
  onJumpToWorktree?: () => void
  onResume: () => void
  onContinueInNewSession?: () => void
  onResumeInNewChat?: () => void
  onResumeInNewCli?: () => void
  resumeLabel: string
  resumeActions: AiVaultSessionResumeActions
  onResumeInWorktree: () => void
  onResumeInNewTab: () => void
  subagentResume?: AiVaultSubagentResumeActions
  onCopyResume?: () => void
  onCopyId: () => void
  onCopyPath?: () => void
  onOpenLog?: () => void
  onRevealLog?: () => void
  onOpenCwd?: () => void
  onRequestDelete?: (session: AiVaultSession) => void
  searchHit?: AiVaultSearchHit
  /** Set in `/resume`'s picker: a click resumes the row, and the row offers no other action. */
  onPick?: () => void
}) {
  const resumeLabel = isAntigravityReferenceSession(session)
    ? translate('aiVault.continueInCli', 'Continue in CLI')
    : defaultResumeLabel
  const updatedAt = session.updatedAt ?? session.modifiedAt
  const title = useAiVaultSessionDisplayTitle(session)
  const detailsId = getSessionDetailsId(session.id)
  const latestTurn = latestSessionConversationTurn(session)
  // Computed once so the dropdown menu and the context menu never disagree.
  const deleteBlockedReason = onRequestDelete
    ? aiVaultSessionDeleteBlockedReason(session)
    : translate(
        'auto.components.right.sidebar.AiVaultSearchEvidence.sourceActionsUnavailable',
        'The transcript source is unavailable.'
      )
  const requestDelete = session.structuredSession
    ? undefined
    : (): void => onRequestDelete?.(session)
  const draggable = !resumeDisabled && !onPick
  const detailsTooltip = detailsExpanded
    ? translate('auto.components.right.sidebar.AiVaultSessionRow.hideDetails', 'Hide Details')
    : translate('auto.components.right.sidebar.AiVaultSessionRow.showDetails', 'Show Details')
  const startResumeDrag = useCallback(
    (event: React.DragEvent<HTMLElement>): void => {
      event.stopPropagation()
      if (!draggable) {
        event.preventDefault()
        return
      }
      writeAiVaultSessionDragData(event.dataTransfer, {
        agent: session.agent,
        sessionId: session.sessionId,
        ...(session.structuredSession ? { structuredSession: session.structuredSession } : {}),
        title,
        command: resumeStartup.command,
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        codexHome: session.codexHome,
        // Why: always sent (null when absent) so drop targets can tell "no cwd"
        // from "payload predates the repin field".
        sessionCwd: session.cwd ?? null,
        ...(resumeStartup.env ? { env: resumeStartup.env } : {}),
        ...(resumeStartup.envToDelete ? { envToDelete: resumeStartup.envToDelete } : {}),
        ...(resumeStartup.launchConfig ? { launchConfig: resumeStartup.launchConfig } : {}),
        ...(session.structuredSession ? {} : { realHomeStartup: realHomeResumeStartup })
      })
      window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_START_EVENT))
    },
    [draggable, realHomeResumeStartup, session, resumeStartup, title]
  )

  const body = (
    <div
      className={cn(
        'group/session-row flex w-full min-w-0 cursor-pointer flex-col border-b border-sidebar-border px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/55',
        !detailsExpanded && 'min-h-[98px]'
      )}
      onClick={(event) => {
        // Radix portals this row's menus out of its DOM, but React still
        // bubbles their clicks here — without this, choosing Delete expands
        // the row behind the dialog.
        const target = event.target
        if (target instanceof Node && !event.currentTarget.contains(target)) {
          return
        }
        if (onPick) {
          onPick()
        } else {
          onToggleDetails()
        }
      }}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1">
        <div
          className={cn(
            'min-w-0 text-[13px] font-medium leading-5 text-foreground',
            // Why: only the title is the resume drag handle — expanded
            // details/preview need text selection and a normal pointer.
            draggable && 'cursor-grab active:cursor-grabbing',
            detailsExpanded ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'line-clamp-1'
          )}
          draggable={draggable}
          title={
            !draggable
              ? undefined
              : translate(
                  'auto.components.right.sidebar.AiVaultSessionRow.dragToResume',
                  'Drag to resume in a new tab'
                )
          }
          onDragStart={startResumeDrag}
          onDragEnd={() => {
            window.dispatchEvent(new Event(AI_VAULT_SESSION_DRAG_END_EVENT))
          }}
        >
          {title}
        </div>
        <SessionRowTrailingActions
          session={session}
          detailsExpanded={detailsExpanded}
          detailsId={detailsId}
          detailsTooltip={detailsTooltip}
          resumeDisabled={resumeDisabled}
          resumeHidden={resumeHidden}
          resumeLabel={resumeLabel}
          worktreeInfo={worktreeInfo}
          onToggleDetails={onToggleDetails}
          onJumpToOriginalPane={onJumpToOriginalPane}
          showJumpToWorktree={showJumpToWorktree}
          onJumpToWorktree={onJumpToWorktree}
          onResume={onResume}
          onContinueInNewSession={onContinueInNewSession}
          onResumeInNewChat={onResumeInNewChat}
          onResumeInNewCli={onResumeInNewCli}
          onCopyResume={onCopyResume}
          onCopyId={onCopyId}
          onCopyPath={onCopyPath}
          onOpenLog={onOpenLog}
          onRevealLog={onRevealLog}
          onOpenCwd={onOpenCwd}
          deleteBlockedReason={deleteBlockedReason}
          onRequestDelete={requestDelete}
          actionsHidden={Boolean(onPick)}
        />
      </div>
      {searchHit ? <AiVaultSearchEvidence hit={searchHit} /> : null}
      {!detailsExpanded && !searchHit ? (
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
      ) : null}
      <SessionMetadata
        session={session}
        liveState={liveState}
        updatedAt={updatedAt}
        worktreeInfo={worktreeInfo}
        vaultScope={vaultScope}
      />
      {detailsExpanded ? (
        <SessionInlineDetails
          id={detailsId}
          session={session}
          worktreeInfo={worktreeInfo}
          vaultScope={vaultScope}
          resumeActions={resumeActions}
          onResumeInWorktree={onResumeInWorktree}
          onResumeInNewTab={onResumeInNewTab}
          subagentResume={onPick ? null : subagentResume}
          onContinueInNewSession={onContinueInNewSession}
          onResumeInNewChat={onResumeInNewChat}
          onResumeInNewCli={onResumeInNewCli}
          // The unsaved notice's "open the log" hint needs the button the picker hides.
          onOpenLog={onPick ? undefined : onOpenLog}
          actionsHidden={Boolean(onPick)}
        />
      ) : null}
    </div>
  )
  if (onPick) {
    return body
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild className="block w-full min-w-0">
        {body}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionActionMenuItems
          menuKind="context"
          resumeDisabled={resumeDisabled}
          resumeHidden={resumeHidden}
          resumeLabel={resumeLabel}
          onJumpToOriginalPane={onJumpToOriginalPane}
          showJumpToWorktree={showJumpToWorktree}
          jumpWorkspaceId={worktreeInfo?.worktreeId}
          onJumpToWorktree={onJumpToWorktree}
          onResume={onResume}
          onContinueInNewSession={onContinueInNewSession}
          onResumeInNewChat={onResumeInNewChat}
          onResumeInNewCli={onResumeInNewCli}
          onCopyResume={onCopyResume}
          onCopyId={onCopyId}
          onCopyPath={onCopyPath}
          onOpenLog={onOpenLog}
          onRevealLog={onRevealLog}
          onOpenCwd={onOpenCwd}
          deleteBlockedReason={deleteBlockedReason}
          onDelete={requestDelete}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
}
