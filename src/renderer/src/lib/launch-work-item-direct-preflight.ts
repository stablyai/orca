import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSetupConfig } from '@/lib/new-workspace'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import type {
  GitHubPrStartPoint,
  GlobalSettings,
  OrcaHooks,
  RepoHookSettings,
  SetupDecision
} from '../../../shared/types'

// Why: preflight routes by the repo's owner host, which `getSettingsForRepoRuntimeOwner`
// hands back as a narrow runtime-scope pick rather than the full GlobalSettings.
type PreflightSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export async function resolveDirectPrStartPoint(
  repoId: string,
  prNumber: number,
  settings: PreflightSettings
): Promise<GitHubPrStartPoint> {
  const target = getActiveRuntimeTarget(settings)
  const result =
    target.kind === 'local'
      ? await window.api.worktrees.resolvePrBase({ repoId, prNumber })
      : await callRuntimeRpc<GitHubPrStartPoint | { error: string }>(
          target,
          'worktree.resolvePrBase',
          { repo: repoId, prNumber },
          { timeoutMs: 30_000 }
        )
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result
}

export async function resolveDirectSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings },
  settings: PreflightSettings
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    // Why: route the hooks probe by the repo's owner host (passed in) so preflight
    // and the subsequent owner-routed createWorktree hit the same host.
    const result = await checkRuntimeHooks(settings, repoId)
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
