import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeStartupForWorktree,
  getAiVaultResumePlatform,
  type AiVaultResumeStartup
} from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import { prepareAiVaultSessionForResume } from '@/lib/ai-vault-session-resume-preparation'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'
import { prepareAiVaultSessionContinuation } from './ai-vault-session-continuation'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { buildAiVaultResumeEntry } from './ai-vault-resume-entry'
import {
  resolveAiVaultSessionLaunchTargetOrNotify,
  resolveAiVaultTargetWorkspacePath
} from './ai-vault-session-launch-target'

export type { AiVaultSessionLaunchTarget } from './ai-vault-session-launch-target'
export { resolveAiVaultSessionLaunchTarget } from './ai-vault-session-launch-target'

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
  copyResumeCommand: (session: AiVaultSession) => Promise<void>
  handleResume: (session: AiVaultSession, targetWorktreeId?: string) => void
  handleContinueInNewSession: (session: AiVaultSession, targetWorktreeId: string) => void
  continuationRequest: AgentSessionContinuationRequest | null
  handleContinuationDialogOpenChange: (open: boolean) => void
} {
  const [continuationRequest, setContinuationRequest] =
    useState<AgentSessionContinuationRequest | null>(null)
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
    async (session: AiVaultSession): Promise<void> => {
      // Host-owned copy: the host re-validates the discovered entry against its own
      // fresh scanner and assembles the command from its settings; the client only
      // echoes identity and writes the returned string. On web/paired the IPC strips
      // filePath and the executing host re-derives it.
      // Why the try/catch: the only caller `void`s this, so an RPC rejection —
      // unknown method on an older paired/web host, or a disconnect — would be an
      // unhandled rejection with no user-visible feedback at all.
      let result: Awaited<ReturnType<typeof window.api.aiVault.resumeCommand>>
      try {
        result = await window.api.aiVault.resumeCommand(
          buildAiVaultResumeEntry(session),
          // The command is pasted into the target workspace's shell, not the
          // host's: a WSL/SSH workspace needs POSIX quoting even on a win32 host.
          getAiVaultResumePlatform(
            useAppStore.getState(),
            activeWorktreeId ?? activeWorktree?.id ?? null
          )
        )
      } catch (error) {
        notifyAiVaultSessionPreparationFailure(error)
        return
      }
      if (result.status !== 'ok') {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.resumeSessionUnavailable',
            'This session can no longer be resumed.'
          )
        )
        return
      }
      try {
        await window.api.ui.writeClipboardText(result.command)
      } catch (error) {
        notifyAiVaultSessionPreparationFailure(error)
        return
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeCommandCopied',
          'Resume command copied'
        )
      )
    },
    [activeWorktree?.id, activeWorktreeId]
  )

  const handleResume = useCallback(
    (session: AiVaultSession, targetWorktreeId?: string): void => {
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
      void prepareAiVaultSessionForResume(session)
        .then((preparedSession) => {
          const launchResult = launchAiVaultSessionInNewTab({
            agent: session.agent,
            worktreeId: targetId.worktreeId,
            ...buildResumeStartup(preparedSession, targetId.worktreeId),
            agentLaunch: {
              vaultResume: {
                operation: 'resume',
                entry: buildAiVaultResumeEntry(preparedSession)
              }
            }
          })
          if (launchResult.tabId === null) {
            void launchResult.runtimeLaunch.then((outcome) => {
              if (outcome.status === 'failed') {
                toast.error(
                  outcome.message ||
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
        .catch(notifyAiVaultSessionPreparationFailure)
    },
    [activeWorktree?.id, activeWorktreeId, buildResumeStartup, targetState]
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
    handleContinueInNewSession,
    continuationRequest,
    handleContinuationDialogOpenChange
  }
}

function notifyAiVaultSessionPreparationFailure(error: unknown): void {
  toast.error(
    error instanceof Error
      ? error.message
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
          'Could not prepare this session for resume.'
        )
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
