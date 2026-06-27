import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  buildAiVaultResumeCommandForWorktree,
  buildAiVaultResumeStartupForWorktree,
  type AiVaultResumeStartup
} from '@/lib/ai-vault-resume-command'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { isNonLocalAiVaultResumeRepo } from '@/lib/ai-vault-resume-target'
import type { AiVaultAgent, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo, Worktree } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { agentLabel } from './ai-vault-session-filters'

export function useAiVaultSessionLaunchActions({
  activeWorktree,
  allWorktrees,
  repos,
  agentCmdOverrides
}: {
  activeWorktree: Worktree | null
  allWorktrees: readonly Worktree[]
  repos: readonly Repo[]
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
        worktreeId: worktreeId ?? activeWorktree?.id ?? null,
        session,
        commandOverride: agentCmdOverrides?.[session.agent]
      }),
    [activeWorktree?.id, agentCmdOverrides]
  )

  const buildResumeStartup = useCallback(
    (session: AiVaultSession, worktreeId?: string | null) =>
      buildAiVaultResumeStartupForWorktree({
        state: useAppStore.getState(),
        worktreeId: worktreeId ?? activeWorktree?.id ?? null,
        session,
        commandOverride: agentCmdOverrides?.[session.agent]
      }),
    [activeWorktree?.id, agentCmdOverrides]
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
      const worktree =
        (targetWorktreeId
          ? allWorktrees.find((candidate) => candidate.id === targetWorktreeId)
          : null) ?? activeWorktree
      if (!worktree) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
            'Open a workspace before resuming a session.'
          )
        )
        return
      }

      const worktreeRepo = repos.find((repo) => repo.id === worktree.repoId)
      if (isNonLocalAiVaultResumeRepo(worktreeRepo)) {
        toast.error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.localWorkspacesOnly',
            'Resume from history is only available in local workspaces.'
          )
        )
        return
      }

      launchAiVaultSessionInNewTab({
        agent: session.agent,
        worktreeId: worktree.id,
        ...buildResumeStartup(session, worktree.id)
      })
      if (useAppStore.getState().activeWorktreeId !== worktree.id) {
        activateAndRevealWorktree(worktree.id)
      }
      toast.success(
        translate(
          'auto.components.right.sidebar.AiVaultPanel.agentSessionQueued',
          '{{value0}} session queued',
          { value0: agentLabel(session.agent) }
        )
      )
    },
    [activeWorktree, allWorktrees, buildResumeStartup, repos]
  )

  return { buildResumeStartup, copyResumeCommand, handleResume }
}
