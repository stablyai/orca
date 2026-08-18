import type { AppState } from '@/store/types'
import { ensureSetupHookConfirmed } from '@/lib/ensure-hooks-confirmed'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

/**
 * Create the workspace behind a session fork.
 *
 * Why: a fork is a real create, so it needs the same per-operation setup approval as
 * every other create path — an authoritative host refuses an unproven hook, which
 * would otherwise strand forks with no setup and no stated reason.
 */
export async function createAgentSessionForkWorkspace(args: {
  store: AppState
  repoId: string
  repo: Repo | undefined
  forkName: string
  sourceBranch: string
  displayName: string
  agent: TuiAgent | null
}): ReturnType<AppState['createWorktree']> {
  const repoOwnerSettings = getSettingsForRepoRuntimeOwner(args.store, args.repoId)
  const setupTrust = await ensureSetupHookConfirmed(
    args.store,
    args.repoId,
    args.repo ? getRepoExecutionHostId(args.repo) : undefined,
    repoOwnerSettings?.activeRuntimeEnvironmentId
  )
  return args.store.createWorktree(
    args.repoId,
    args.forkName,
    args.sourceBranch,
    setupTrust.decision === 'skip' ? 'skip' : 'inherit',
    undefined,
    'terminal_context_menu',
    args.displayName,
    undefined,
    undefined,
    undefined,
    args.agent ?? undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    setupTrust.approval ? { setupHookApproval: setupTrust.approval } : undefined
  )
}
