import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../../shared/skill-delete-contract'
import {
  SKILL_DELETE_CAPABILITY,
  SKILL_DELETE_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/skill-install-capability'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  type RuntimeClientTarget
} from './runtime-rpc-client'

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

const SKILL_DELETE_PREVIEW_TIMEOUT_MS = 60_000
const SKILL_DELETE_TIMEOUT_MS = 5 * 60_000

/**
 * Whether the delete affordance may be offered at all. The gate lives here,
 * beside where `callRuntimeRpc` is actually invoked — the main-process
 * `callRuntimeEnvironment` path install and remove use is a different,
 * non-overlapping transport, so a check there would never run for this.
 */
export async function runtimeTargetSupportsSkillDelete(
  runtimeTarget: RuntimeClientTarget | null
): Promise<boolean> {
  if (!runtimeTarget) {
    return false
  }
  if (runtimeTarget.kind === 'local') {
    // Desktop answers true immediately; on web the "local" host is a remote
    // server that updates independently, so the preload probes its capability.
    return window.api.skills.deleteSupported()
  }
  return runtimeEnvironmentSupportsCapability(runtimeTarget.environmentId, SKILL_DELETE_CAPABILITY)
}

async function assertSkillDeleteSupported(runtimeTarget: RuntimeClientTarget): Promise<void> {
  if (runtimeTarget.kind === 'local') {
    if (!(await window.api.skills.deleteSupported())) {
      throw new Error(SKILL_DELETE_UPDATE_REQUIRED_MESSAGE)
    }
    return
  }
  try {
    await assertRuntimeEnvironmentCapability(
      runtimeTarget.environmentId,
      SKILL_DELETE_CAPABILITY,
      SKILL_DELETE_UPDATE_REQUIRED_MESSAGE
    )
  } catch (error) {
    // A capability change racing the gate has no main-process hook to reuse:
    // `recordSkillCapabilityAbsence` imports the main tracer and its capability
    // parameter is a closed union over main-side capabilities.
    console.warn('[skills] delete capability absent at call time', error)
    throw error
  }
}

export async function previewSkillDeletionOnRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  request: SkillDeleteRequest
): Promise<SkillDeletePlan> {
  await assertSkillDeleteSupported(runtimeTarget)
  if (runtimeTarget.kind === 'local') {
    return window.api.skills.previewDelete(request)
  }
  return callRuntimeRpc<SkillDeletePlan>(runtimeTarget, 'skills.previewDelete', request, {
    timeoutMs: SKILL_DELETE_PREVIEW_TIMEOUT_MS
  })
}

export async function deleteSkillsOnRuntimeTarget(
  runtimeTarget: RuntimeClientTarget,
  request: SkillDeleteRequest
): Promise<SkillDeleteResult> {
  await assertSkillDeleteSupported(runtimeTarget)
  if (runtimeTarget.kind === 'local') {
    return window.api.skills.delete(request)
  }
  return callRuntimeRpc<SkillDeleteResult>(runtimeTarget, 'skills.delete', request, {
    timeoutMs: SKILL_DELETE_TIMEOUT_MS
  })
}
