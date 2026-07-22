import { getSetupConfig } from '@/lib/new-workspace'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import type {
  GitHubPrStartPoint,
  GlobalSettings,
  OrcaHooks,
  RepoHookSettings,
  SetupDecision
} from '../../../shared/types'
import type { ExecutionHostId } from '../../../shared/execution-host'

// Why: preflight callers pass settings routed to the exact repository owner host
// rather than inheriting the globally focused runtime.
type PreflightSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export async function resolveDirectPrStartPoint(
  repoId: string,
  prNumber: number,
  settings: PreflightSettings,
  hints: {
    branchName?: string
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  } = {},
  hostId?: ExecutionHostId
): Promise<GitHubPrStartPoint> {
  return resolveGitHubPrStartPointForRepo({
    repoId,
    prNumber,
    settings,
    executionHostId: hostId,
    headRefName: hints.headRefName ?? hints.branchName,
    baseRefName: hints.baseRefName,
    isCrossRepository: hints.isCrossRepository
  })
}

export async function resolveDirectSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings },
  settings: PreflightSettings,
  hostId?: ExecutionHostId
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    // Why: route the hooks probe by the repo's owner host (passed in) so preflight
    // and the subsequent owner-routed createWorktree hit the same host.
    const result = await checkRuntimeHooks(settings, repoId, hostId)
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
