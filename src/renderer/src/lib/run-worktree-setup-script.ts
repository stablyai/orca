import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../shared/execution-host'

export type RunWorktreeSetupScriptResult =
  | { status: 'launched'; primaryTabId: string | null }
  | {
      status: 'skipped'
      reason:
        | 'worktree-missing'
        | 'repo-missing'
        | 'folder-repo'
        | 'no-setup-configured'
        | 'trust-skipped'
        | 'activation-failed'
    }
  | { status: 'error'; message: string }

/**
 * Manual re-run of the worktree setup script (#10015).
 * Materializes the same setup runner used at create, then launches via the
 * existing Setup tab / split path (`setupScriptLaunchMode`).
 */
export async function runWorktreeSetupScript(
  worktreeId: string
): Promise<RunWorktreeSetupScriptResult> {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    toast.error(
      translate(
        'auto.lib.runWorktreeSetupScript.worktreeMissing',
        'Workspace is no longer available.'
      )
    )
    return { status: 'skipped', reason: 'worktree-missing' }
  }

  const repo = state.repos.find((entry) => entry.id === worktree.repoId)
  if (!repo) {
    toast.error(
      translate('auto.lib.runWorktreeSetupScript.repoMissing', 'Project is no longer available.')
    )
    return { status: 'skipped', reason: 'repo-missing' }
  }

  if (isFolderRepo(repo)) {
    toast.info(
      translate(
        'auto.lib.runWorktreeSetupScript.folderRepo',
        'Folder workspaces do not use setup scripts.'
      )
    )
    return { status: 'skipped', reason: 'folder-repo' }
  }

  // Why: same trust gate as create — shared orca.yaml setup must be confirmed before run.
  const trust = await ensureHooksConfirmed(
    useAppStore.getState(),
    repo.id,
    'setup',
    getRepoExecutionHostId(repo)
  )
  if (trust !== 'run') {
    return { status: 'skipped', reason: 'trust-skipped' }
  }

  let prepared: Awaited<ReturnType<typeof window.api.hooks.prepareSetupRunner>>
  try {
    prepared = await window.api.hooks.prepareSetupRunner({
      repoId: repo.id,
      worktreePath: worktree.path
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    toast.error(
      translate(
        'auto.lib.runWorktreeSetupScript.prepareFailed',
        'Could not prepare the setup script.'
      ),
      { description: message }
    )
    return { status: 'error', message }
  }

  if (prepared.status === 'error') {
    const message = prepared.message ?? 'Could not prepare the setup script.'
    toast.error(
      translate(
        'auto.lib.runWorktreeSetupScript.runnerFailed',
        'Could not prepare the setup script.'
      ),
      { description: message }
    )
    return { status: 'error', message }
  }

  if (!prepared.setup) {
    if (prepared.reason === 'folder-repo') {
      toast.info(
        translate(
          'auto.lib.runWorktreeSetupScript.folderRepo',
          'Folder workspaces do not use setup scripts.'
        )
      )
      return { status: 'skipped', reason: 'folder-repo' }
    }
    toast.info(
      translate(
        'auto.lib.runWorktreeSetupScript.noSetup',
        'No setup script is configured for this project.'
      )
    )
    return { status: 'skipped', reason: 'no-setup-configured' }
  }

  const activation = activateAndRevealWorktree(worktreeId, { setup: prepared.setup })
  if (!activation) {
    toast.error(
      translate(
        'auto.lib.runWorktreeSetupScript.activationFailed',
        'Could not open the workspace to run setup.'
      )
    )
    return { status: 'skipped', reason: 'activation-failed' }
  }

  return { status: 'launched', primaryTabId: activation.primaryTabId }
}
