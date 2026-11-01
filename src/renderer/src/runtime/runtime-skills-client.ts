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
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const SKILL_DISCOVERY_TIMEOUT_MS = 15_000

/** Scan where skills execute (#6789). Current targets describe client-local WSL/project hosts, so omit them remotely; future workspace callers may forward cwd/worktreeId, not whole targets. Forward request-scoped refresh and portable inventory filters so explicit rechecks reach remote disk beyond shared scans. */
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
    // Desktop supports immediately; web’s local API is an independently updated server and must probe.
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
    // This capability race cannot reuse recordSkillCapabilityAbsence: it imports main tracing and accepts only main’s closed capability union.
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
