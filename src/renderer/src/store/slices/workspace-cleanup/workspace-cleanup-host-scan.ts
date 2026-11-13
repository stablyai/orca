/** Each process scans the repos it owns: desktop main over IPC, every paired or SSH host's own server over RPC. */
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import {
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanProgress,
  type WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { createUnreachableHostCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup-unreachable-host-candidate'
import { shortWorkspaceCleanupBranchName } from '../../../../../shared/workspace-cleanup/workspace-cleanup-candidate-fields'
import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/runtime-rpc-error-code'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { selectWorktreesByRepo } from '../../workspaces/catalog/workspace-record-fields'
import {
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../worktrees/listing/worktree-host-ownership'

// A host lists and stats every workspace before replying; per-repo Git reads have their own timeouts.
// The deadline also closes the host's request, so a stalled scan stops there too.
const REMOTE_HOST_SCAN_TIMEOUT_MS = 120_000

/** Same-id repo rows (a server's own and its nested-SSH twin) collapse to one entry. */
type RemoteCleanupHost = {
  environmentId: string
  hostId: ExecutionHostId
  reposById: Map<string, Repo>
}

// Remote legs by scan id, so cancelling a scan also closes its host-side work.
const remoteScanControllers = new Map<string, AbortController>()

export async function scanWorkspaceCleanupHosts(
  args: WorkspaceCleanupScanArgs,
  state: AppState,
  onProgress?: (progress: WorkspaceCleanupScanProgress) => void
): Promise<WorkspaceCleanupScanResult> {
  const controller = new AbortController()
  if (args.scanId) {
    remoteScanControllers.set(args.scanId, controller)
  }
  try {
    const [local, ...remote] = await Promise.all([
      window.api.workspaceCleanup.scan(args, onProgress),
      ...listRemoteCleanupHosts(state).map((host) =>
        scanRemoteHost(host, args, state, controller.signal)
      )
    ])
    return {
      scannedAt: local.scannedAt,
      candidates: [...local.candidates, ...remote.flatMap((result) => result.candidates)],
      errors: [...local.errors, ...remote.flatMap((result) => result.errors)]
    }
  } finally {
    // A failed local leg must not leave host work running where cancel can no longer reach it.
    controller.abort()
    if (args.scanId && remoteScanControllers.get(args.scanId) === controller) {
      remoteScanControllers.delete(args.scanId)
    }
  }
}

export function cancelWorkspaceCleanupHostScan(scanId: string): Promise<boolean> {
  remoteScanControllers.get(scanId)?.abort()
  return window.api.workspaceCleanup.cancelScan?.(scanId) ?? Promise.resolve(false)
}

/** Paired servers this window knows; a stamp naming no known server is a local-store row main scans. */
function listRemoteCleanupHosts(state: AppState): RemoteCleanupHost[] {
  const knownEnvironmentIds = new Set(
    state.runtimeEnvironments.map((environment) => environment.id)
  )
  const hosts = new Map<string, RemoteCleanupHost>()
  for (const repo of state.repos) {
    const host = parseRoutableExecutionHostId(getRepoExecutionHostId(repo))
    if (host?.kind !== 'runtime' || !knownEnvironmentIds.has(host.environmentId)) {
      continue
    }
    const entry = hosts.get(host.environmentId) ?? {
      environmentId: host.environmentId,
      hostId: host.id,
      reposById: new Map<string, Repo>()
    }
    if (!entry.reposById.has(repo.id)) {
      entry.reposById.set(repo.id, repo)
    }
    hosts.set(host.environmentId, entry)
  }
  return [...hosts.values()]
}

async function scanRemoteHost(
  host: RemoteCleanupHost,
  args: WorkspaceCleanupScanArgs,
  state: AppState,
  signal: AbortSignal
): Promise<Pick<WorkspaceCleanupScanResult, 'candidates' | 'errors'>> {
  const ownsWorktree = (worktreeId: string): boolean =>
    host.reposById.has(getRepoIdFromWorktreeId(worktreeId))
  const requestedIds = args.worktreeId ? [args.worktreeId] : args.worktreeIds
  const worktreeIds = requestedIds
    ?.filter(ownsWorktree)
    .slice(0, WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
  if (worktreeIds?.length === 0) {
    return { candidates: [], errors: [] }
  }
  try {
    const result = await callRuntimeRpc<WorkspaceCleanupScanResult>(
      { kind: 'environment', environmentId: host.environmentId },
      'workspaceCleanup.scan',
      {
        ...(worktreeIds ? { worktreeIds } : {}),
        ...(args.skipGitWorktreeIds
          ? { skipGitWorktreeIds: args.skipGitWorktreeIds.filter(ownsWorktree) }
          : {}),
        ...(args.includeAllWorkspaces !== undefined
          ? { includeAllWorkspaces: args.includeAllWorkspaces }
          : {}),
        // Main refreshes activity for a single target implicitly; the batch form needs it said.
        ...(args.refreshActivity !== undefined || args.worktreeId
          ? { refreshActivity: args.refreshActivity ?? true }
          : {})
      },
      { timeoutMs: REMOTE_HOST_SCAN_TIMEOUT_MS, reuseRecentCompatibilityFailure: true, signal }
    )
    // The server answers in its own spelling (its repos are `local`); this window names it runtime:E.
    return {
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        executionHostId: host.hostId
      })),
      errors: result.errors.map((error) => ({ ...error, executionHostId: host.hostId }))
    }
  } catch (error) {
    // A cancelled scan is discarded; an older host cannot scan, so its rows stay out as before.
    if (signal.aborted || hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return { candidates: [], errors: [] }
    }
    console.warn(`Workspace cleanup could not reach host ${host.hostId}`, error)
    return {
      candidates: listUnreachableHostCandidates(host, state, worktreeIds, args),
      errors: []
    }
  }
}

/** Rows this window already knows for a host it cannot reach, blocked until it answers again. */
function listUnreachableHostCandidates(
  host: RemoteCleanupHost,
  state: AppState,
  worktreeIds: readonly string[] | undefined,
  args: WorkspaceCleanupScanArgs
): WorkspaceCleanupCandidate[] {
  // Legacy suggestion scans omit hosts they cannot inspect, as desktop main does.
  if (!worktreeIds && args.includeAllWorkspaces !== true) {
    return []
  }
  const targets = worktreeIds ? new Set(worktreeIds) : null
  const worktreesByRepo = selectWorktreesByRepo(state)
  const scannedAt = Date.now()
  return [...host.reposById.values()].flatMap((repo) => {
    const matchOptions = worktreeHostMatchOptions(state, repo.id, host.hostId)
    return (worktreesByRepo[repo.id] ?? [])
      .filter(
        (worktree) =>
          worktreeMatchesHost(worktree, host.hostId, matchOptions) &&
          (!targets || targets.has(worktree.id))
      )
      .map((worktree) =>
        createUnreachableHostCleanupCandidate(
          repo,
          host.hostId,
          {
            ...worktree,
            worktreeId: worktree.id,
            branch: shortWorkspaceCleanupBranchName(worktree.branch)
          },
          scannedAt
        )
      )
  })
}
