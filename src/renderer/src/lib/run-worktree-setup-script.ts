import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { ensureHooksConfirmed } from '@/lib/ensure-hooks-confirmed'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { translate } from '@/i18n/i18n'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getWorktreeExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export type RunWorktreeSetupScriptResult =
  | { status: 'launched'; primaryTabId: string | null }
  | {
      status: 'skipped'
      reason:
        | 'worktree-missing'
        | 'repo-missing'
        | 'folder-repo'
        | 'remote-host'
        | 'no-setup-configured'
        | 'trust-skipped'
        | 'activation-failed'
    }
  | { status: 'error'; message: string }

function notifyRemoteHostUnsupported(): void {
  toast.info(
    translate(
      'auto.lib.runWorktreeSetupScript.remoteHost',
      'Run setup script is not yet supported for remote worktrees. Create a new worktree to run setup on that host, or open a local clone.'
    )
  )
}

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

  // Why: duplicate repo ids across hosts are a supported state; resolve the row the
  // worktree actually belongs to instead of taking the first id match.
  const matchingRepos = state.repos.filter((entry) => entry.id === worktree.repoId)
  const repo = worktree.hostId
    ? findRepoForHost(matchingRepos, worktree.repoId, { hostId: worktree.hostId })
    : matchingRepos.length === 1
      ? matchingRepos[0]
      : findRepoForHost(matchingRepos, worktree.repoId, { settings: state.settings })
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

  // Why: reject before any trust or IPC work — the worktree's own host wins over the
  // repo fallback, and a remote-host trust fetch can fail and end the flow silently.
  const hostId = getWorktreeExecutionHostId(worktree, repo)
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    notifyRemoteHostUnsupported()
    return { status: 'skipped', reason: 'remote-host' }
  }

  let prepared: Awaited<ReturnType<typeof window.api.hooks.prepareSetupRunner>>
  try {
    prepared = await window.api.hooks.prepareSetupRunner({
      repoId: repo.id,
      worktreePath: worktree.path,
      hostId
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
    if (prepared.reason === 'remote-host') {
      notifyRemoteHostUnsupported()
      return { status: 'skipped', reason: 'remote-host' }
    }
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

  // Why: confirm the script the runner will execute — the worktree's orca.yaml can
  // differ from the repo root the generic trust inspection reads. The canonical
  // trustContent (setup + defaultTabs commands) keeps the per-repo hash slot in sync
  // with the create flow. Purely local Settings scripts are user-owned: no repo trust.
  if (prepared.setupScriptSource !== 'local') {
    const trustContent = (prepared.trustContent ?? prepared.setupScript ?? '').trim()
    const trust = await ensureHooksConfirmed(
      useAppStore.getState(),
      repo.id,
      'setup',
      hostId,
      undefined,
      trustContent ? { scriptContentOverride: trustContent } : undefined
    )
    if (trust !== 'run') {
      return { status: 'skipped', reason: 'trust-skipped' }
    }
  }

  const activation = activateAndRevealWorktree(worktreeId, {
    setup: prepared.setup,
    executionHostId: hostId
  })
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
