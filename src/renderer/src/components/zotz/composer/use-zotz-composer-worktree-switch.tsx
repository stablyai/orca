import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SwitchIndicator } from '@/components/ui/switch'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { useTranslate } from '@/i18n/use-translate'
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

/** Puts the project's own checkout on the chosen branch; returns git's refusal (e.g. a dirty tree) or null. */
async function moveCheckoutToBranch(
  checkout: Worktree,
  wanted: string | undefined
): Promise<string | null> {
  const target = zotzCheckoutSwitchTarget(checkout.branch, wanted)
  if (!target) {
    return null
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
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
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
  // Inline, not a toast: the user has to pick a way out, and repeat clicks must not stack.
  const [switchError, setSwitchError] = useState<string | null>(null)
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
    const refusal = await moveCheckoutToBranch(checkout, input.baseBranch)
    setBusy(false)
    setSwitchError(refusal)
    if (refusal) {
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
              onValueChange={(next) => {
                setSwitchError(null)
                input.onBaseBranchChange?.(next || undefined)
              }}
            />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={createWorktree}
            onClick={() => {
              setSwitchError(null)
              setCreateWorktree((value) => !value)
            }}
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
        {switchError && !createWorktree ? (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
          >
            <p className="font-medium text-destructive">
              {t('zotz.composer.switchFailed', 'The project folder cannot switch to that branch')}
            </p>
            <p className="text-destructive/85">{switchError}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  setSwitchError(null)
                  setCreateWorktree(true)
                }}
              >
                {t('zotz.composer.useWorktree', 'Use a worktree instead')}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setSwitchError(null)
                  input.onBaseBranchChange?.(undefined)
                }}
              >
                {t('zotz.composer.stayOnBranch', 'Stay on {{branch}}', {
                  branch: shortBranch(checkout.branch)
                })}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    ) : null

  return {
    createWorktree: useWorktree,
    branchRow,
    onCreate: useWorktree ? input.onCreate : () => void openInProject(),
    createDisabled: useWorktree ? input.createDisabled : busy
  }
}
