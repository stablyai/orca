import {
  notifyAiVaultSessionPreparationFailure,
  resolveAiVaultSessionLaunchTargetOrNotify
} from './ai-vault-session-launch-feedback'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeCommandSession,
  type AiVaultResumeStartup
} from '@/lib/ai-vault-resume-command'
import {
  assertAiVaultCopiedSessionLaunchAllowed,
  buildAiVaultCopiedSessionStartupForWorktree,
  buildAiVaultForkStartupForWorktree
} from '@/lib/ai-vault-session-fork-startup'
import { launchAiVaultSessionAndReveal } from '@/lib/launch-ai-vault-session-and-reveal'
import { useAppStore } from '@/store'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  dropDeletedRemoteResumeCwd,
  prepareAiVaultSessionForFork,
  prepareAiVaultSessionForResume,
  prepareAiVaultSessionForTerminalResume
} from '@/lib/ai-vault-session-resume-preparation'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { describeAiVaultCliForkFailure } from './ai-vault-session-cli-fork'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { prepareAiVaultSessionContinuation } from './ai-vault-session-continuation'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { adoptsCliConversations } from '../../../../shared/structured-agent-cli-conversation-adoption'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { describeAiVaultResumeFailure } from '@/lib/ai-vault-resume-refusal'
import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'

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
        notifyAiVaultSessionPreparationFailure(error, session.agent)
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
      void prepareStartup(targetId.worktreeId)
        .then((startup) =>
          launchAiVaultSessionAndReveal(
            { agent: session.agent, worktreeId: targetId.worktreeId, ...startup },
            describeFailure
          )
        )
        .catch((error: unknown) =>
          notifyAiVaultSessionPreparationFailure(error, session.agent, describeFailure)
        )
    },
    [activeWorktree?.id, activeWorktreeId, targetState]
  )

  const handleResume = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
      if (session.structuredSession) {
        void activateAiVaultStructuredSession(session)
        return
      }
      launchInTerminal(
        session,
        targetWorktreeId,
        (worktreeId) =>
          prepareAiVaultSessionForTerminalResume(session)
            .then(dropDeletedRemoteResumeCwd)
            .then((preparedSession) => buildResumeStartup(preparedSession, worktreeId)),
        (message) => describeAiVaultResumeFailure(new Error(message), session.agent)
      )
    },
    [buildResumeStartup, launchInTerminal]
  )

  // Native chat keeps the conversation it owns; the terminal gets a copy (see the fork builder).
  const handleResumeInNewCli = useCallback(
    (session: AiVaultSession, targetWorktreeId: string): void => {
      const prepareStartup = async (worktreeId: string): Promise<AiVaultResumeStartup> => {
        assertAiVaultCopiedSessionLaunchAllowed({
          state: useAppStore.getState(),
          worktreeId,
          session,
          commandOverride: agentCmdOverrides?.[session.agent]
        })
        const prepared = await prepareAiVaultSessionForFork(session)
        const target = await dropDeletedRemoteResumeCwd(prepared.session)
        // A copy the chat's host already made is the terminal's own conversation: a plain resume.
        const startup = prepared.copied
          ? buildAiVaultCopiedSessionStartupForWorktree(
              {
                state: useAppStore.getState(),
                worktreeId,
                session: target,
                commandOverride: agentCmdOverrides?.[target.agent]
              },
              session.agent
            )
          : buildAiVaultForkStartupForWorktree({
              state: useAppStore.getState(),
              worktreeId,
              session: target,
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
      if (!adoptsCliConversations(session.agent)) {
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
