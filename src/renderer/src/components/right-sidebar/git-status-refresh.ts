import { getRuntimeGitStatus, getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
import type {
  GitPushTarget,
  GitStatusResult,
  GitUpstreamStatus,
  GlobalSettings
} from '../../../../shared/types'

export type GitStatusRefreshDeps = {
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: {
      runtimeTargetSettings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
      applyUpstreamStatus?: boolean
    }
  ) => Promise<GitUpstreamStatus | null>
}

const MAX_REFRESH_ORDERING_WORKTREES = 1024
const strictUpstreamRefreshGenerationByWorktree = new Map<string, number>()
const automaticUpstreamRefreshInFlightByWorktree = new Map<string, number>()

function trimRefreshOrderingState(): void {
  for (const worktreeId of strictUpstreamRefreshGenerationByWorktree.keys()) {
    if (strictUpstreamRefreshGenerationByWorktree.size <= MAX_REFRESH_ORDERING_WORKTREES) {
      break
    }
    if (automaticUpstreamRefreshInFlightByWorktree.has(worktreeId)) {
      continue
    }
    strictUpstreamRefreshGenerationByWorktree.delete(worktreeId)
  }
}

function beginAutomaticUpstreamRefresh(worktreeId: string): number {
  automaticUpstreamRefreshInFlightByWorktree.set(
    worktreeId,
    (automaticUpstreamRefreshInFlightByWorktree.get(worktreeId) ?? 0) + 1
  )
  return strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0
}

function finishAutomaticUpstreamRefresh(worktreeId: string): void {
  const count = automaticUpstreamRefreshInFlightByWorktree.get(worktreeId) ?? 0
  if (count <= 1) {
    automaticUpstreamRefreshInFlightByWorktree.delete(worktreeId)
  } else {
    automaticUpstreamRefreshInFlightByWorktree.set(worktreeId, count - 1)
  }
  trimRefreshOrderingState()
}

function shouldApplyAutomaticUpstreamRefresh(worktreeId: string, startGeneration: number): boolean {
  return (strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0) === startGeneration
}

async function fetchAndApplyAutomaticUpstreamStatus({
  settings,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps,
  startGeneration
}: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: GitStatusRefreshDeps
  startGeneration: number
}): Promise<void> {
  const upstreamStatus = await deps.fetchUpstreamStatus(
    worktreeId,
    worktreePath,
    connectionId,
    pushTarget,
    {
      runtimeTargetSettings: settings,
      applyUpstreamStatus: false
    }
  )
  if (upstreamStatus && shouldApplyAutomaticUpstreamRefresh(worktreeId, startGeneration)) {
    deps.setUpstreamStatus(worktreeId, upstreamStatus)
  }
}

function beginStrictUpstreamRefresh(worktreeId: string): void {
  strictUpstreamRefreshGenerationByWorktree.set(
    worktreeId,
    (strictUpstreamRefreshGenerationByWorktree.get(worktreeId) ?? 0) + 1
  )
  trimRefreshOrderingState()
}

export function clearGitStatusRefreshOrderingForTests(): void {
  strictUpstreamRefreshGenerationByWorktree.clear()
  automaticUpstreamRefreshInFlightByWorktree.clear()
}

export async function refreshGitStatusForWorktree({
  settings,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps
}: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: GitStatusRefreshDeps
}): Promise<void> {
  const upstreamStartGeneration = beginAutomaticUpstreamRefresh(worktreeId)
  try {
    const status = (await getRuntimeGitStatus({
      settings,
      worktreeId,
      worktreePath,
      connectionId
    })) as GitStatusResult

    if (!shouldApplyAutomaticUpstreamRefresh(worktreeId, upstreamStartGeneration)) {
      return
    }

    deps.setGitStatus(worktreeId, status)
    // Why: branch switches can happen inside a terminal. `git status --branch`
    // gives us the new identity without a separate worktree-list poll.
    deps.updateWorktreeGitIdentity(worktreeId, {
      head: status.head,
      // Why: detached HEAD reports a head oid and no branch. Pass null as an
      // explicit clear signal so stale branch names don't linger in the UI.
      branch: status.branch ?? (status.head ? null : undefined)
    })
    if (pushTarget) {
      // Why: porcelain status reports Git's configured upstream. Source Control
      // actions for PR-created worktrees must instead reconcile with Orca's
      // explicit publish target.
      await fetchAndApplyAutomaticUpstreamStatus({
        settings,
        worktreeId,
        worktreePath,
        connectionId,
        pushTarget,
        deps,
        startGeneration: upstreamStartGeneration
      })
      return
    }
    if (status.upstreamStatus) {
      if (
        status.upstreamStatus.ahead > 0 &&
        status.upstreamStatus.behind > 0 &&
        status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
      ) {
        // Why: porcelain status has counts but cannot tell stale post-rebase
        // upstream commits from real remote work. Writing it first makes the
        // primary action flicker between Sync and Force Push on every poll.
        await fetchAndApplyAutomaticUpstreamStatus({
          settings,
          worktreeId,
          worktreePath,
          connectionId,
          deps,
          startGeneration: upstreamStartGeneration
        })
        return
      }
      deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
      return
    }
    await fetchAndApplyAutomaticUpstreamStatus({
      settings,
      worktreeId,
      worktreePath,
      connectionId,
      pushTarget,
      deps,
      startGeneration: upstreamStartGeneration
    })
  } finally {
    finishAutomaticUpstreamRefresh(worktreeId)
  }
}

export async function refreshGitStatusForWorktreeStrict({
  settings,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps
}: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: Omit<GitStatusRefreshDeps, 'fetchUpstreamStatus'> & {
    fetchUpstreamStatus?: GitStatusRefreshDeps['fetchUpstreamStatus']
  }
}): Promise<{ status: GitStatusResult; upstreamStatus: GitUpstreamStatus }> {
  beginStrictUpstreamRefresh(worktreeId)
  const status = (await getRuntimeGitStatus(
    {
      settings,
      worktreeId,
      worktreePath,
      connectionId
    },
    {
      // Why: strict refreshes are user-triggered reconciliation and must not reuse
      // automatic polling's no-upstream backoff window.
      bypassEffectiveUpstreamNegativeCache: true
    }
  )) as GitStatusResult

  deps.setGitStatus(worktreeId, status)
  // Why: branch switches can happen inside a terminal. `git status --branch`
  // gives us the new identity without a separate worktree-list poll.
  deps.updateWorktreeGitIdentity(worktreeId, {
    head: status.head,
    // Why: detached HEAD reports a head oid and no branch. Pass null as an
    // explicit clear signal so stale branch names don't linger in the UI.
    branch: status.branch ?? (status.head ? null : undefined)
  })
  if (pushTarget) {
    // Why: porcelain status reports Git's configured upstream. Source Control
    // actions for PR-created worktrees must instead reconcile with Orca's
    // explicit publish target.
    const upstreamStatus = await getRuntimeGitUpstreamStatus(
      { settings, worktreeId, worktreePath, connectionId },
      pushTarget
    )
    deps.setUpstreamStatus(worktreeId, upstreamStatus)
    return { status, upstreamStatus }
  }
  if (status.upstreamStatus) {
    if (
      status.upstreamStatus.ahead > 0 &&
      status.upstreamStatus.behind > 0 &&
      status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
    ) {
      // Why: porcelain status has counts but cannot tell stale post-rebase
      // upstream commits from real remote work. Writing it first makes the
      // primary action flicker between Sync and Force Push on every poll.
      const upstreamStatus = await getRuntimeGitUpstreamStatus(
        { settings, worktreeId, worktreePath, connectionId },
        undefined
      )
      deps.setUpstreamStatus(worktreeId, upstreamStatus)
      return { status, upstreamStatus }
    }
    deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
    return { status, upstreamStatus: status.upstreamStatus }
  }
  const upstreamStatus = await getRuntimeGitUpstreamStatus(
    { settings, worktreeId, worktreePath, connectionId },
    undefined
  )
  deps.setUpstreamStatus(worktreeId, upstreamStatus)
  return { status, upstreamStatus }
}
