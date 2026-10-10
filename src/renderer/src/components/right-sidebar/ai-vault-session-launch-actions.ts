import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeCommandSession,
  type AiVaultResumeStartup
} from '@/lib/ai-vault-resume-command'
import { buildAiVaultForkStartupForWorktree } from '@/lib/ai-vault-session-fork-startup'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { useAppStore } from '@/store'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  dropDeletedSshResumeCwd,
  prepareAiVaultSessionForFork,
  prepareAiVaultSessionForResume
} from '@/lib/ai-vault-session-resume-preparation'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import { describeAiVaultCliForkFailure } from './ai-vault-session-cli-fork'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { prepareAiVaultSessionContinuation } from './ai-vault-session-continuation'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  activateAiVaultResumeWorkspace,
  resumeAiVaultSessionInNewChat
} from './ai-vault-session-resume-in-chat-launch'
import {
  aiVaultResumeUnsupportedMessage,
  resolveAiVaultSessionLaunchTarget,
  resolveAiVaultTargetWorkspacePath
} from './ai-vault-session-launch-target'

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
}) {
  const [continuationRequest, setContinuationRequest] =
    useState<AgentSessionContinuationRequest | null>(null)

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
    (session: AiVaultResumeCommandSession, worktreeId?: string | null) =>
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
      if (session.structuredSession) {
        return
      }
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
        notifyAiVaultSessionPreparationFailure(error)
      }
    },
    [buildResumeCommand]
  )

  const launchInTerminal = useCallback(
    (
      session: AiVaultSession,
      targetWorktreeId: string | undefined,
      prepareStartup: (worktreeId: string) => Promise<AiVaultResumeStartup>,
      describeFailure: (message: string) => string = (message) => message
    ): void => {
      const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        activeWorktreeId: activeWorktreeId ?? activeWorktree?.id ?? null,
        targetWorktreeId,
        targetState
      })
      if (!targetId) {
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
      void prepareStartup(targetId.worktreeId)
        .then((startup) => {
          const launchResult = launchAiVaultSessionInNewTab({
            agent: session.agent,
            worktreeId: targetId.worktreeId,
            ...startup
          })
          if (launchResult.tabId === null) {
            void launchResult.runtimeLaunch.then((outcome) => {
              if (outcome.status === 'failed') {
                toast.error(
                  describeFailure(outcome.message) ||
                    translate(
                      'auto.lib.launch.agent.in.new.tab.11cce5cc77',
                      'Could not launch {{value0}} in a new terminal.',
                      { value0: agentLabel(session.agent) }
                    )
                )
                return
              }
              if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
                activateAiVaultResumeWorkspace(targetId.worktreeId)
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
        .catch((error: unknown) => notifyAiVaultSessionPreparationFailure(error, describeFailure))
    },
    [activeWorktree?.id, activeWorktreeId, targetState]
  )

  const handleResume = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
      if (session.structuredSession) {
        void activateAiVaultStructuredSession(session)
        return
      }
      launchInTerminal(session, targetWorktreeId, (worktreeId) =>
        prepareAiVaultSessionForResume(session)
          .then(dropDeletedSshResumeCwd)
          .then((preparedSession) => buildResumeStartup(preparedSession, worktreeId))
      )
    },
    [buildResumeStartup, launchInTerminal]
  )

  // Native chat keeps the conversation it owns; the terminal gets a copy (see the fork builder).
  const handleResumeInNewCli = useCallback(
    (session: AiVaultSession, targetWorktreeId: string): void => {
      const prepareStartup = async (worktreeId: string): Promise<AiVaultResumeStartup> => {
        const startup = buildAiVaultForkStartupForWorktree({
          state: useAppStore.getState(),
          worktreeId,
          session: await prepareAiVaultSessionForFork(session).then(dropDeletedSshResumeCwd),
          commandOverride: agentCmdOverrides?.[session.agent]
        })
        if (!startup) {
          throw new Error(
            translate(
              'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliUnavailable',
              'This session cannot be opened in the CLI.'
            )
          )
        }
        return startup
      }
      launchInTerminal(session, targetWorktreeId, prepareStartup, describeAiVaultCliForkFailure)
    },
    [agentCmdOverrides, launchInTerminal]
  )

  const handleResumeInNewChat = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
      if (!isAgentSessionHandleProvider(session.agent)) {
        return
      }
      const worktreeId = targetWorktreeId ?? activeWorktreeId ?? activeWorktree?.id ?? null
      if (!worktreeId) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
            'Open a workspace before resuming a session.'
          )
        )
        return
      }
      void resumeAiVaultSessionInNewChat(
        session,
        session.agent,
        worktreeId,
        newAgentLaunchRequestId()
      )
    },
    [activeWorktree?.id, activeWorktreeId]
  )

  const handleContinueInNewSession = useCallback(
    (session: AiVaultSession, targetWorktreeId: string): void => {
      const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        activeWorktreeId: activeWorktreeId ?? activeWorktree?.id ?? null,
        targetWorktreeId,
        targetState
      })
      if (!targetId) {
        return
      }

      const targetWorkspacePath = resolveAiVaultTargetWorkspacePath(
        targetState,
        targetId.worktreeId
      )
      if (!targetWorkspacePath) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
            'Open a workspace before resuming a session.'
          )
        )
        return
      }
      setContinuationRequest(
        prepareAiVaultSessionContinuation({
          session,
          targetWorktreeId: targetId.worktreeId,
          targetWorkspacePath
        })
      )
    },
    [activeWorktree?.id, activeWorktreeId, targetState]
  )

  const handleContinuationDialogOpenChange = useCallback((open: boolean): void => {
    if (!open) {
      setContinuationRequest(null)
    }
  }, [])

  return {
    buildResumeStartup,
    copyResumeCommand,
    handleResume,
    handleResumeInNewCli,
    handleResumeInNewChat,
    handleContinueInNewSession,
    continuationRequest,
    handleContinuationDialogOpenChange
  }
}

function notifyAiVaultSessionPreparationFailure(
  error: unknown,
  describeFailure: (message: string) => string = (message) => message
): void {
  toast.error(
    error instanceof Error
      ? describeFailure(error.message)
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
          'Could not prepare this session for resume.'
        )
  )
}

function resolveAiVaultSessionLaunchTargetOrNotify(
  args: Parameters<typeof resolveAiVaultSessionLaunchTarget>[0]
): Extract<ReturnType<typeof resolveAiVaultSessionLaunchTarget>, { status: 'ready' }> | null {
  const target = resolveAiVaultSessionLaunchTarget(args)
  if (target.status === 'missing') {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    )
    return null
  }
  if (target.status === 'unsupported') {
    toast.error(aiVaultResumeUnsupportedMessage(target.targetStatus))
    return null
  }
  return target
}
