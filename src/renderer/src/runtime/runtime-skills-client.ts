import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

const SKILL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Discover skills on the runtime that actually runs them: the local desktop host
 * (or its WSL/project runtime) by default, or a connected remote Orca runtime
 * when one is active. This keeps install badges in sync with where the skill
 * files land instead of always reading the client's disk (#6789).
 *
 * `runtime`/`wslDistro`/`projectRuntime` describe the *client's* host, so they
 * are dropped for a remote call — forwarding them would ask a Linux server to
 * resolve a WSL distro it does not have. Only workspace identity travels; the
 * server resolves its own project runtime from `worktreeId`.
 */
export async function discoverSkillsForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  target?: SkillDiscoveryTarget
): Promise<SkillDiscoveryResult> {
  if (runtimeTarget.kind === 'local') {
    return window.api.skills.discover(target)
  }
  const cwd = target?.cwd?.trim() || undefined
  const worktreeId = target?.worktreeId?.trim() || undefined
  return callRuntimeRpc<SkillDiscoveryResult>(
    runtimeTarget,
    'skills.discover',
    { ...(cwd ? { cwd } : {}), ...(worktreeId ? { worktreeId } : {}) },
    { timeoutMs: SKILL_DISCOVERY_TIMEOUT_MS }
  )
}
