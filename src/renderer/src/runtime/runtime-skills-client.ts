import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../../shared/skill-delete-contract'
import { SKILL_DELETE_UPDATE_REQUIRED_MESSAGE } from '../../../shared/skill-install-capability'
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
 * Portable inventory filters also apply to the remote disk being scanned.
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
    {
      ...(target?.refresh ? { refresh: true } : {}),
      ...(target?.names?.length ? { names: target.names } : {}),
      ...(target?.sourceKinds?.length ? { sourceKinds: target.sourceKinds } : {})
    },
    { timeoutMs: SKILL_DISCOVERY_TIMEOUT_MS }
  )
}

const PAIRED_SKILL_DELETE_UNSUPPORTED_MESSAGE =
  'Deleting skills through a paired client is not supported. Run the command from Orca on the machine that stores the skills.'

/**
 * Whether the delete affordance may be offered at all. Paired environment
 * targets share the runtime-scoped WebSocket with web/phone clients, so delete
 * stays host-local (unix-socket / preload) only.
 */
export async function runtimeTargetSupportsSkillDelete(
  runtimeTarget: RuntimeClientTarget | null
): Promise<boolean> {
  if (!runtimeTarget || runtimeTarget.kind !== 'local') {
    return false
  }
  // Desktop answers true immediately; on web the "local" host is a remote
  // server that updates independently, so the preload probes its capability.
  return window.api.skills.deleteSupported()
}

async function assertSkillDeleteSupported(runtimeTarget: RuntimeClientTarget): Promise<void> {
  if (runtimeTarget.kind !== 'local') {
    throw new Error(PAIRED_SKILL_DELETE_UNSUPPORTED_MESSAGE)
  }
  if (!(await window.api.skills.deleteSupported())) {
    throw new Error(SKILL_DELETE_UPDATE_REQUIRED_MESSAGE)
  }
}

export async function previewSkillDeletionOnRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  request: SkillDeleteRequest
): Promise<SkillDeletePlan> {
  await assertSkillDeleteSupported(runtimeTarget)
  return window.api.skills.previewDelete(request)
}

export async function deleteSkillsOnRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  request: SkillDeleteRequest
): Promise<SkillDeleteResult> {
  await assertSkillDeleteSupported(runtimeTarget)
  return window.api.skills.delete(request)
}
