import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeStartup
} from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import {
  canResumeAiVaultSessionOnTarget,
  getAiVaultResumeWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus
} from '@/lib/ai-vault-resume-target'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import type { Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  isKnownAiVaultResumeWorkspaceTarget,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'

export function useAiVaultSessionLaunchActions({
  activeWorktree,
  activeWorktreeId,
  targetState,
  agentCmdOverrides
}: {
  activeWorktree: Worktree | null
  activeWorktreeId: string | null
  targetState: AiVaultSessionResumeTargetState
  agentCmdOverrides?: Partial<Record<AiVaultAgent, string | null>>
}): {
  buildResumeStartup: (session: AiVaultSession, worktreeId?: string | null) => AiVaultResumeStartup
  copyResumeCommand: (session: AiVaultSession, worktreeId?: string | null) => Promise<void>
  handleResume: (session: AiVaultSession, targetWorktreeId?: string) => void
} {
  const buildResumeCommand = useCallback(
    (session: AiVaultSession, worktreeId?: string | null): string =>
      buildAiVaultResumeCopyCommandForWorktree({
        state: useAppStore.getState(),
        worktreeId: worktreeId ?? activeWorktreeId ?? activeWorktree?.id ?? null,
        session,
        commandOverride: agentCmdOverrides?.[session.agent]
      }),
    [activeWorktree?.id, activeWorktreeId, agentCmdOverrides]
  )

  const buildResumeStartup = useCallback(
    (session: AiVaultSession, worktreeId?: string | null) =>
      buildAiVaultResumeStartupForWorktree({
        state: useAppStore.getState(),
        worktreeId: worktreeId ?? activeWorktreeId ?? activeWorktree?.id ?? null,
        session,
        commandOverride: agentCmdOverrides?.[session.agent]
      }),
    [activeWorktree?.id, activeWorktreeId, agentCmdOverrides]
  )

  const copyResumeCommand = useCallback(
    async (session: AiVaultSession, worktreeId?: string | null): Promise<void> => {
      try {
        const preparedSession = await prepareAiVaultSessionForResume(session)
        await window.api.ui.writeClipboardText(buildResumeCommand(preparedSession, worktreeId))
        toast.success(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeCommandCopied',
            'Resume command copied'
          )
        )
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Could not prepare this session for resume.'
        )
      }
    },
    [buildResumeCommand]
  )

  const handleResume = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
      const targetId = resolveAiVaultSessionLaunchTarget({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        activeWorktreeId: activeWorktreeId ?? activeWorktree?.id ?? null,
        targetWorktreeId,
        targetState
      })
      if (targetId.status === 'missing') {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
            'Open a workspace before resuming a session.'
          )
        )
        return
      }

      if (targetId.status === 'unsupported') {
        toast.error(aiVaultResumeUnsupportedMessage(targetId.targetStatus))
        return
      }

      const showQueuedToast = (): void => {
        toast.success(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
            '{{value0}} session queued',
            { value0: agentLabel(session.agent) }
          )
        )
      }
      void prepareAiVaultSessionForResume(session)
        .then((preparedSession) => {
          const launchResult = launchAiVaultSessionInNewTab({
            agent: session.agent,
            worktreeId: targetId.worktreeId,
            ...buildResumeStartup(preparedSession, targetId.worktreeId)
          })
          if (launchResult.tabId === null) {
            void launchResult.runtimeLaunch.then((created) => {
              if (!created) {
                toast.error(
                  translate(
                    'auto.lib.launch.agent.in.new.tab.11cce5cc77',
                    'Could not launch {{value0}} in a new terminal.',
                    { value0: agentLabel(session.agent) }
                  )
                )
                return
              }
              showQueuedToast()
            })
            return
          }
          if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
            activateAiVaultResumeWorkspace(targetId.worktreeId)
          }
          showQueuedToast()
        })
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Could not prepare this session for resume.'
          )
        })
    },
    [activeWorktree?.id, activeWorktreeId, buildResumeStartup, targetState]
  )

  return { buildResumeStartup, copyResumeCommand, handleResume }
}

export type AiVaultSessionLaunchTarget =
  | { status: 'missing' }
  | {
      status: 'unsupported'
      targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
    }
  | { status: 'ready'; worktreeId: string }

export function resolveAiVaultSessionLaunchTarget(args: {
  sessionFilePath: string | null
  sessionExecutionHostId?: AiVaultSession['executionHostId'] | null
  activeWorktreeId: string | null
  targetWorktreeId?: string
  targetState: AiVaultSessionResumeTargetState
}): AiVaultSessionLaunchTarget {
  const targetWorktreeId = args.targetWorktreeId ?? args.activeWorktreeId
  if (
    !targetWorktreeId ||
    !isKnownAiVaultResumeWorkspaceTarget(args.targetState, targetWorktreeId)
  ) {
    return { status: 'missing' }
  }

  const targetStatus = getAiVaultResumeWorkspaceTargetStatus(args.targetState, targetWorktreeId)
  const targetExecutionHostId = getAiVaultResumeWorkspaceExecutionHostId(
    args.targetState,
    targetWorktreeId
  )
  if (
    !canResumeAiVaultSessionOnTarget({
      sessionFilePath: args.sessionFilePath,
      sessionExecutionHostId: args.sessionExecutionHostId,
      targetStatus,
      targetExecutionHostId
    })
  ) {
    return { status: 'unsupported', targetStatus }
  }

  return { status: 'ready', worktreeId: targetWorktreeId }
}

function aiVaultResumeUnsupportedMessage(
  targetStatus: ReturnType<typeof getAiVaultResumeWorkspaceTargetStatus>
): string {
  // Why: local and SSH targets can both be valid generally; this branch means
  // the session's recorded host does not match the selected workspace.
  if (targetStatus === 'ssh' || targetStatus === 'local' || targetStatus === 'runtime') {
    return translate(
      'auto.components.right.sidebar.AiVaultPanel.sessionHostMismatchUnsupported',
      'This session belongs to a different host. Open a workspace on the same host to resume it.'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultPanel.openSupportedWorkspace',
    'Open a workspace before resuming a session.'
  )
}

function activateAiVaultResumeWorkspace(workspaceId: string): void {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }
  activateAndRevealWorktree(workspaceId)
}
