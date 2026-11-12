import {
  notifyAiVaultSessionNoContinuationContext,
  notifyAiVaultSessionNeedsWorkspace,
  notifyAiVaultSessionPreparationFailure,
  resolveAiVaultSessionLaunchTargetOrNotify
} from './ai-vault-session-launch-feedback'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCopyCommandForWorktree,
  buildAiVaultResumeStartupForWorktree
} from '@/lib/agent-session/resume/history/ai-vault-resume-command'
import {
  assertAiVaultCopiedSessionLaunchAllowed,
  buildAiVaultCopiedSessionStartupForWorktree,
  buildAiVaultForkStartupForWorktree
} from '@/lib/agent-session/resume/history/ai-vault-session-fork-startup'
import { launchAiVaultSessionAndReveal } from '@/lib/agent-session/resume/history/launch-ai-vault-session-and-reveal'
import { useAppStore } from '@/store/index'
import {
  dropDeletedRemoteResumeCwd,
  prepareAiVaultSessionForFork,
  prepareAiVaultSessionForResume,
  prepareAiVaultSessionForTerminalResume
} from '@/lib/agent-session/resume/history/ai-vault-session-resume-preparation'
import { translate } from '@/i18n/i18n'
import { describeAiVaultCliForkFailure } from './ai-vault-session-cli-fork'
import {
  loadDatabaseAiVaultSessionContinuation,
  prepareAiVaultSessionContinuation
} from './ai-vault-session-continuation'
import { isAiVaultDatabaseAgent } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-handoff'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import { adoptsCliConversations } from '../../../../../../shared/structured-agent-cli-conversation-adoption'

import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
import { describeAiVaultResumeFailure } from '@/lib/agent-session/resume/history/ai-vault-resume-refusal'
import { resumeAiVaultSessionInNewChat } from './ai-vault-session-resume-in-chat-launch'
import { resolveAiVaultTargetWorkspacePath } from './ai-vault-session-launch-target'
import type {
  AiVaultResumeCommandSession,
  AiVaultResumeStartup
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-startup'
import type {
  AiVaultAgent,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  AiVaultSessionResumeState,
  AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session/context/agent-session-continuation'

export function useAiVaultSessionLaunchActions({
  activeWorktree,
  activeWorktreeId,
  targetState,
  getSessionResumeState,
  agentCmdOverrides
}: {
  activeWorktree: Worktree | null
  activeWorktreeId: string | null
  targetState: AiVaultSessionResumeTargetState
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  agentCmdOverrides?: Partial<Record<AiVaultAgent, string | null>>
}) {
  // An open dialog whose request is null is still saving the conversation on its host.
  const [continuation, setContinuation] = useState<{
    request: AgentSessionContinuationRequest | null
  } | null>(null)
  // Only the latest Hand Off may fill or close the dialog.
  const continuationAttempt = useRef<object | null>(null)

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
      const original = getSessionResumeState(session)
      const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        activeWorktreeId: activeWorktreeId ?? activeWorktree?.id ?? null,
        targetWorktreeId,
        sessionWorktreeId: original.usesSessionWorktree ? original.worktreeId : null,
        targetState
      })
      if (!targetId) {
        return
      }
      void prepareStartup(targetId.worktreeId)
        .then((startup) =>
          launchAiVaultSessionAndReveal(
            {
              agent: session.agent,
              worktreeId: targetId.worktreeId,
              workspaceExecutionHostId: targetId.executionHostId ?? undefined,
              ...startup
            },
            describeFailure
          )
        )
        .catch((error: unknown) =>
          notifyAiVaultSessionPreparationFailure(error, session.agent, describeFailure)
        )
    },
    [activeWorktree?.id, activeWorktreeId, getSessionResumeState, targetState]
  )

  const handleResume = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
      if (session.structuredSession) {
        void activateAiVaultStructuredSession(
          session,
          undefined,
          structuredAgentSessionTargetForHost(session.executionHostId) ?? undefined
        )
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
        notifyAiVaultSessionNeedsWorkspace()
        return
      }
      void resumeAiVaultSessionInNewChat(
        session,
        session.agent,
        worktreeId,
        createNonSecureContextUuid()
      )
    },
    [activeWorktree?.id, activeWorktreeId]
  )

  const handleContinueInNewSession = useCallback(
    (session: AiVaultSession, targetWorktreeId: string): void => {
      const original = getSessionResumeState(session)
      const targetId = resolveAiVaultSessionLaunchTargetOrNotify({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        activeWorktreeId: activeWorktreeId ?? activeWorktree?.id ?? null,
        targetWorktreeId,
        sessionWorktreeId: original.usesSessionWorktree ? original.worktreeId : null,
        targetState
      })
      if (!targetId) {
        return
      }

      const targetWorkspacePath = resolveAiVaultTargetWorkspacePath(
        targetState,
        targetId.worktreeId,
        session.executionHostId
      )
      if (!targetWorkspacePath) {
        notifyAiVaultSessionNeedsWorkspace()
        return
      }
      const target = { session, targetWorktreeId: targetId.worktreeId, targetWorkspacePath }
      const attempt = {}
      continuationAttempt.current = attempt
      if (!isAiVaultDatabaseAgent(session.agent)) {
        setContinuation({ request: prepareAiVaultSessionContinuation(target) })
        return
      }
      setContinuation({ request: null })
      void loadDatabaseAiVaultSessionContinuation(target).then((request) => {
        if (continuationAttempt.current !== attempt) {
          return
        }
        if (request) {
          setContinuation({ request })
          return
        }
        setContinuation(null)
        notifyAiVaultSessionNoContinuationContext()
      })
    },
    [activeWorktree?.id, activeWorktreeId, getSessionResumeState, targetState]
  )

  const handleContinuationDialogOpenChange = useCallback((open: boolean): void => {
    if (!open) {
      continuationAttempt.current = null
      setContinuation(null)
    }
  }, [])

  return {
    buildResumeStartup,
    copyResumeCommand,
    handleResume,
    handleResumeInNewCli,
    handleResumeInNewChat,
    handleContinueInNewSession,
    continuationOpen: continuation !== null,
    continuationRequest: continuation?.request ?? null,
    handleContinuationDialogOpenChange
  }
}
