import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

const SKILL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Discover skills on the runtime that actually runs them: the local desktop host
 * (or its WSL/project runtime) by default, or a connected remote Orca runtime
 * when one is active. This keeps install badges in sync with where the skill
 * files land instead of always reading the client's disk (#6789).
 *
 * `target` only ever describes the *client's* host — a WSL distro or a local
 * project-runtime resolution — none of which means anything to the server, and
 * forwarding it would ask a Linux server to resolve a WSL distro it does not
 * have. A remote runtime scans its own home roots and its own repos, so the
 * target is dropped entirely for the remote call.
 */
export async function discoverSkillsForRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  target?: SkillDiscoveryTarget
): Promise<SkillDiscoveryResult> {
  if (runtimeTarget.kind === 'local') {
    return window.api.skills.discover(target)
  }
  return callRuntimeRpc<SkillDiscoveryResult>(
    runtimeTarget,
    'skills.discover',
    {},
    { timeoutMs: SKILL_DISCOVERY_TIMEOUT_MS }
  )
}
