import { getSetupConfig } from '@/lib/new-workspace'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { Repo } from '../../../shared/repo-types'
import type { OrcaHooks, RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { GitHubPrStartPoint } from '../../../shared/worktree/types'

export async function resolveDirectPrStartPoint(
  repoId: string,
  prNumber: number,
  target: RuntimeClientTarget | null,
  hints: {
    branchName?: string
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  } = {}
): Promise<GitHubPrStartPoint> {
  return resolveGitHubPrStartPointForRepo({
    repoId,
    prNumber,
    target,
    headRefName: hints.headRefName ?? hints.branchName,
    baseRefName: hints.baseRefName,
    isCrossRepository: hints.isCrossRepository
  })
}

export async function resolveDirectSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings },
  ownerHostId: ExecutionHostId
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    // Why: the same owner host as the PR start point and createWorktree, never focus.
    const result = await checkRuntimeHooks(ownerHostId, repoId)
    yamlHooks = (result.hooks as OrcaHooks | null) ?? null
  } catch {
    yamlHooks = null
  }
  const setupConfig = getSetupConfig(repo, yamlHooks)
  if (!setupConfig) {
    // Why: no setup script configured, so this path should behave like callers
    // that omit a setup decision entirely.
    return { kind: 'decided', decision: 'inherit' }
  }
  const policy = repo.hookSettings?.setupRunPolicy ?? 'run-by-default'
  if (policy === 'ask') {
    return { kind: 'needs-modal' }
  }
  return {
    kind: 'decided',
    decision: policy === 'run-by-default' ? 'run' : 'skip'
  }
}

export type DirectLaunchOwnerRow = {
  repo: Repo
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
}

/**
 * The one repo row a direct launch runs on: setup preflight, the PR start point, hook trust and
 * createWorktree all take its host. `null` when no row or several hosts share the id, which the
 * caller sends to the create modal instead of breaking the tie by focus.
 */
export function resolveDirectLaunchOwnerRow(
  repos: readonly Repo[],
  repoId: string
): DirectLaunchOwnerRow | null {
  const rows = repos.filter((r) => r.id === repoId)
  if (rows.length !== 1) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(rows[0])
  const target = ipcOrRuntimeTargetForHostId(executionHostId)
  return target ? { repo: rows[0], executionHostId, target } : null
}
