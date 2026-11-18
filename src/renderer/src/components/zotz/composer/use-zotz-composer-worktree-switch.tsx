import React, { useState } from 'react'
import { SwitchIndicator } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

type ComposerInputs = {
  repoId: string
  selectedRepoIsGit: boolean
  quickAgent: TuiAgent | null
  onCreate: () => void
  createDisabled: boolean
}

/** The project's own checkout: where a conversation without a worktree runs. */
function useProjectCheckoutId(repoId: string): string | null {
  return useAppStore(
    (s) => selectWorktreesByRepo(s)[repoId]?.find((worktree) => worktree.isMainWorktree)?.id ?? null
  )
}

/**
 * Conductor-style choice in the create dialog: on, a worktree from the selected branch (upstream's
 * flow); off, the conversation opens straight in the project's folder on its current branch.
 */
export function useZotzComposerWorktreeSwitch(input: ComposerInputs): {
  createWorktree: boolean
  switchRow: React.ReactNode
  onCreate: () => void
  createDisabled: boolean
} {
  const t = useTranslate()
  const [createWorktree, setCreateWorktree] = useState(true)
  const checkoutId = useProjectCheckoutId(input.repoId)
  const closeModal = useAppStore((s) => s.closeModal)
  const available = input.selectedRepoIsGit && checkoutId !== null
  const useWorktree = createWorktree || !available

  const openInProject = (): void => {
    if (!checkoutId) {
      return
    }
    closeModal()
    activateAndRevealWorktree(checkoutId)
    if (!input.quickAgent) {
      return
    }
    // Refusals already toast from the launcher.
    launchAgentInNewTabWithOutcome({
      requestId: createNonSecureContextUuid(),
      agent: input.quickAgent,
      worktreeId: checkoutId,
      launchSource: 'new_workspace_composer'
    })
  }

  const switchRow = available ? (
    <button
      type="button"
      role="switch"
      aria-checked={createWorktree}
      onClick={() => setCreateWorktree((value) => !value)}
      className="group flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <SwitchIndicator checked={createWorktree} className="mt-0.5" />
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm text-foreground">
          {t('zotz.composer.worktreeLabel', 'Create a worktree')}
        </span>
        <span className="block text-xs text-muted-foreground">
          {createWorktree
            ? t(
                'zotz.composer.worktreeOn',
                'A separate copy on a new branch, based on the branch you pick below. The agent never touches your project folder.'
              )
            : t(
                'zotz.composer.worktreeOff',
                'The conversation opens in the project folder, on the branch it has checked out now.'
              )}
        </span>
      </span>
    </button>
  ) : null

  return {
    createWorktree: useWorktree,
    switchRow,
    onCreate: useWorktree ? input.onCreate : openInProject,
    createDisabled: useWorktree ? input.createDisabled : false
  }
}
