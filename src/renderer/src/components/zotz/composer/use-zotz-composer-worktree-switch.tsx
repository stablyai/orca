import React, { useState } from 'react'
import { toast } from 'sonner'
import { SwitchIndicator } from '@/components/ui/switch'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useRepoMap } from '@/store/repos/use-repository-catalog'
import { useWorktreesForRepo } from '@/store/slices/worktrees/listing/use-worktree-catalog'
import { launchAgentInNewTabWithOutcome } from '@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { switchRuntimeGitBranch } from '@/runtime/source-control/git/runtime-git-branch-client'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { BranchSwitchTarget } from '../../../../../shared/git/branch-switch-target'
import type { Worktree } from '../../../../../shared/worktree/types'

type ComposerInputs = {
  repoId: string
  selectedRepoIsGit: boolean
  quickAgent: TuiAgent | null
  baseBranch?: string
  onBaseBranchChange?: (value: string | undefined) => void
  onCreate: () => void
  createDisabled: boolean
}

function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

/** The switch the checkout needs to sit on `wanted`, or null when it already does. */
export function zotzCheckoutSwitchTarget(
  currentBranch: string,
  wanted: string | undefined
): BranchSwitchTarget | null {
  const current = shortBranch(currentBranch)
  const desired = wanted ? shortBranch(wanted) : ''
  if (!desired || desired === current || desired === `origin/${current}`) {
    return null
  }
  return desired.startsWith('origin/')
    ? { kind: 'remote', name: desired }
    : { kind: 'local', name: desired }
}

/** Puts the project's own checkout on the chosen branch; a dirty tree or busy branch refuses with a toast. */
async function moveCheckoutToBranch(
  checkout: Worktree,
  wanted: string | undefined,
  t: Translate
): Promise<boolean> {
  const target = zotzCheckoutSwitchTarget(checkout.branch, wanted)
  if (!target) {
    return true
  }
  try {
    await switchRuntimeGitBranch(
      {
        target: runtimeTargetForOwnerEnvironment(checkout.runtimeOwnerEnvironmentId ?? null),
        worktreeId: checkout.id,
        worktreePath: checkout.path
      },
      target
    )
    return true
  } catch (error) {
    toast.error(
      t('zotz.composer.switchFailed', 'Could not switch the project folder to that branch'),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
    return false
  }
}

/**
 * Conductor-style branch row in the create dialog: pick the branch, then choose whether a worktree
 * is made from it (upstream's flow) or the conversation works on it in the project's own folder.
 */
export function useZotzComposerWorktreeSwitch(input: ComposerInputs): {
  createWorktree: boolean
  branchRow: React.ReactNode
  onCreate: () => void
  createDisabled: boolean
} {
  const t = useTranslate()
  const [createWorktree, setCreateWorktree] = useState(true)
  const [busy, setBusy] = useState(false)
  const repoMap = useRepoMap()
  const repoWorktrees = useWorktreesForRepo(input.repoId)
  const checkout = repoWorktrees.find((worktree) => worktree.isMainWorktree) ?? null
  const closeModal = useAppStore((s) => s.closeModal)
  const available = input.selectedRepoIsGit && checkout !== null
  const useWorktree = createWorktree || !available

  const openInProject = async (): Promise<void> => {
    if (!checkout || busy) {
      return
    }
    setBusy(true)
    const moved = await moveCheckoutToBranch(checkout, input.baseBranch, t)
    setBusy(false)
    if (!moved) {
      return
    }
    closeModal()
    activateAndRevealWorktree(checkout.id)
    if (input.quickAgent) {
      // Refusals already toast from the launcher.
      launchAgentInNewTabWithOutcome({
        requestId: createNonSecureContextUuid(),
        agent: input.quickAgent,
        worktreeId: checkout.id,
        launchSource: 'new_workspace_composer'
      })
    }
  }

  const branchRow =
    available && input.onBaseBranchChange ? (
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">
          {t('zotz.composer.branchLabel', 'Branch')}
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <CreateFromPicker
              key={input.repoId}
              repoId={input.repoId}
              repoMap={repoMap}
              worktrees={repoWorktrees}
              // Without a worktree the folder stays on its branch until the user picks another.
              value={input.baseBranch ?? (createWorktree ? '' : shortBranch(checkout.branch))}
              onValueChange={(next) => input.onBaseBranchChange?.(next || undefined)}
            />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={createWorktree}
            onClick={() => setCreateWorktree((value) => !value)}
            className="group flex shrink-0 items-center gap-1.5 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SwitchIndicator checked={createWorktree} size="compact" />
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">
              {t('zotz.composer.worktreeLabel', 'Worktree')}
            </span>
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {createWorktree
            ? t(
                'zotz.composer.worktreeOn',
                'A new worktree is created from this branch; your project folder stays as it is.'
              )
            : t(
                'zotz.composer.worktreeOff',
                'The conversation works on this branch in the project folder. Zotz switches the folder to it first.'
              )}
        </p>
      </div>
    ) : null

  return {
    createWorktree: useWorktree,
    branchRow,
    onCreate: useWorktree ? input.onCreate : () => void openInProject(),
    createDisabled: useWorktree ? input.createDisabled : busy
  }
}
