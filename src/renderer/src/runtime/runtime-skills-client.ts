import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'

const SKILL_DISCOVERY_TIMEOUT_MS = 15_000

/**
 * Discover skills on the runtime that actually runs them: the local desktop host
 * (or its WSL/project runtime) by default, or a connected remote Orca runtime
 * when one is active. This keeps install badges in sync with where the skill
 * files land instead of always reading the client's disk (#6789).
 *
 * The target is otherwise dropped for a remote call. Every target any caller can
 * currently produce describes the *client's* host — a WSL distro or a local
 * project-runtime resolution — and forwarding those would ask a Linux server to
 * resolve a WSL distro it does not have. The server does honour `cwd` and
 * `worktreeId` (see `main/runtime/rpc/methods/skills.ts`), so if a caller ever
 * supplies workspace identity, forward those two fields rather than widening
 * this to the whole target.
 *
 * `refresh` is the exception and must be forwarded: it describes the *request*,
 * not the client's host, and it is the only way an explicit re-check reaches
 * past the remote host's shared scans to its disk.
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
    target?.refresh ? { refresh: true } : {},
    { timeoutMs: SKILL_DISCOVERY_TIMEOUT_MS }
  )
}
