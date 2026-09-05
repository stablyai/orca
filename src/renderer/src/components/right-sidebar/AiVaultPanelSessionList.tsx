import { useCallback } from 'react'
import { toast } from 'sonner'
import type { AgentStatusState } from '../../../../shared/agent-status-types'
import type { AiVaultSessionMessageHit } from '../../../../shared/ai-vault-session-message-hit'
import type {
  AiVaultListResult,
  AiVaultScope,
  AiVaultSession
} from '../../../../shared/ai-vault-types'
import type { AiVaultResumeStartup } from '@/lib/ai-vault-resume-command'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { translate } from '@/i18n/i18n'
import { AgentSessionContinuationDialog } from '@/components/agent-session-continuation/AgentSessionContinuationDialog'
import { AiVaultScanIssueBanners } from './AiVaultScanIssueBanners'
import { AiVaultSessionVirtualList } from './AiVaultSessionVirtualList'
import type { AiVaultSessionGroup } from './ai-vault-session-filters'
import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import {
  openAiVaultSessionLogInOrca,
  openAiVaultSessionMessageJump
} from './ai-vault-session-log-open'
import type {
  AiVaultSessionResumeActions,
  AiVaultSessionResumeState
} from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'

export type AiVaultPanelSessionListProps = {
  groups: readonly AiVaultSessionGroup[]
  collapsedGroups: ReadonlySet<string>
  loading: boolean
  sessionsCount: number
  filteredSessionsCount: number
  noAgentsSelected: boolean
  error: string | null
  aiError: string | null
  scanResult: AiVaultListResult | null
  vaultScope: AiVaultScope
  messageHitsBySessionId: ReadonlyMap<string, AiVaultSessionMessageHit>
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  getOriginalPaneTarget: (session: AiVaultSession) => AiVaultOriginalPaneTarget | null
  getSessionLiveState: (session: AiVaultSession) => AgentStatusState | null
  getWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  onToggleGroup: (key: string) => void
  onJumpToOriginalPane: (session: AiVaultSession) => void
  onJumpToWorktree: (worktreeId: string) => void
  onResume: (session: AiVaultSession, worktreeId: string) => void
  onContinueInNewSession: (session: AiVaultSession, worktreeId: string) => void
  onCopyResume: (session: AiVaultSession, worktreeId?: string | null) => void
  continuationRequest: AgentSessionContinuationRequest | null
  onContinuationOpenChange: (open: boolean) => void
  onRequestDelete: (session: AiVaultSession) => void
}

export function AiVaultPanelSessionList({
  groups,
  collapsedGroups,
  loading,
  sessionsCount,
  filteredSessionsCount,
  noAgentsSelected,
  error,
  aiError,
  scanResult,
  vaultScope,
  messageHitsBySessionId,
  buildResumeStartup,
  getSessionResumeState,
  getSessionResumeActions,
  getOriginalPaneTarget,
  getSessionLiveState,
  getWorktreeInfo,
  onToggleGroup,
  onJumpToOriginalPane,
  onJumpToWorktree,
  onResume,
  onContinueInNewSession,
  onCopyResume,
  continuationRequest,
  onContinuationOpenChange,
  onRequestDelete
}: AiVaultPanelSessionListProps): React.JSX.Element {
  const copyText = useCallback(async (text: string, label: string): Promise<void> => {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.right.sidebar.AiVaultPanel.valueCopied', '{{value0}} copied', {
        value0: label
      })
    )
  }, [])

  return (
    <>
      {error || aiError ? (
        <div className="border-b border-sidebar-border px-3 py-2 text-xs text-destructive">
          {error ?? aiError}
        </div>
      ) : null}

      <AiVaultScanIssueBanners scanResult={scanResult} />

      <AiVaultSessionVirtualList
        groups={groups}
        collapsedGroups={collapsedGroups}
        loading={loading}
        sessionsCount={sessionsCount}
        filteredSessionsCount={filteredSessionsCount}
        noAgentsSelected={noAgentsSelected}
        error={error}
        vaultScope={vaultScope}
        buildResumeStartup={buildResumeStartup}
        getSessionResumeState={getSessionResumeState}
        getSessionResumeActions={getSessionResumeActions}
        getOriginalPaneTarget={getOriginalPaneTarget}
        getSessionLiveState={getSessionLiveState}
        getWorktreeInfo={getWorktreeInfo}
        getSearchHit={(sessionId) => messageHitsBySessionId.get(sessionId)}
        onToggleGroup={onToggleGroup}
        onJumpToOriginalPane={onJumpToOriginalPane}
        onJumpToWorktree={onJumpToWorktree}
        onResume={onResume}
        onContinueInNewSession={onContinueInNewSession}
        onCopyResume={onCopyResume}
        onCopyId={(session) =>
          void copyText(
            session.sessionId,
            translate('auto.components.right.sidebar.AiVaultPanel.sessionId', 'Session ID')
          )
        }
        onCopyPath={(session) =>
          void copyText(
            session.filePath,
            translate('auto.components.right.sidebar.AiVaultPanel.logPath', 'Log path')
          )
        }
        onOpenLog={(session) => void openAiVaultSessionLogInOrca(session)}
        onRevealLog={(session) => void window.api.shell.openPath(session.filePath)}
        onOpenCwd={(session) => {
          if (session.cwd) {
            void window.api.shell.openPath(session.cwd)
          }
        }}
        onRequestDelete={onRequestDelete}
        onJumpToHit={(session, hit) => void openAiVaultSessionMessageJump(session, hit.jump)}
      />
      {continuationRequest ? (
        <AgentSessionContinuationDialog
          open
          request={continuationRequest}
          onOpenChange={onContinuationOpenChange}
        />
      ) : null}
    </>
  )
}
