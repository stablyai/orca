import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCommandForWorktree,
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
      buildAiVaultResumeCommandForWorktree({
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
      await window.api.ui.writeClipboardText(buildResumeCommand(session, worktreeId))
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeCommandCopied',
          'Resume command copied'
        )
      )
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

      launchAiVaultSessionInNewTab({
        agent: session.agent,
        worktreeId: targetId.worktreeId,
        ...buildResumeStartup(session, targetId.worktreeId)
      })
      if (useAppStore.getState().activeWorktreeId !== targetId.worktreeId) {
        activateAiVaultResumeWorkspace(targetId.worktreeId)
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
          '{{value0}} session queued',
          { value0: agentLabel(session.agent) }
        )
      )
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
  if (targetStatus === 'runtime') {
    return translate(
      'auto.components.right.sidebar.AiVaultPanel.runtimeWorkspacesUnsupported',
      'Resume from history is not available in runtime-hosted workspaces.'
    )
  }
  // Why: local and SSH targets can both be valid generally; this branch means
  // the session's recorded host does not match the selected workspace.
  if (targetStatus === 'ssh' || targetStatus === 'local') {
    return translate(
      'auto.components.right.sidebar.AiVaultPanel.sessionHostMismatchUnsupported',
      'This session belongs to a different host. Open a workspace on the same host to resume it.'
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultPanel.openSupportedWorkspace',
    'Open a local or SSH workspace before resuming a session.'
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
