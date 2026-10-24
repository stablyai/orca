import type {
  BundledSkillInstallResult,
  BundledSkillPlan,
  BundledSkillPlanRequest
} from '../../../shared/bundled-skill-plan'
import { BUNDLED_ORCA_SKILL_CAPABILITY } from '../../../shared/skill-install-capability'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

const BUNDLED_SKILL_PLAN_TIMEOUT_MS = 60_000
const BUNDLED_SKILL_EXECUTE_TIMEOUT_MS = 5 * 60_000

/** `unsupported`: the host answered its status and predates the capability ("Update Orca on
 *  the server"). A failed probe is not this; it rejects like any other error. */
export type BundledSkillPlanResult =
  | { kind: 'plan'; plan: BundledSkillPlan }
  /** `connect-host`: an SSH host no Orca server serves yet; never planned on this machine. */
  | { kind: 'unsupported'; reason: BundledSkillUnsupportedReason }

export type BundledSkillUnsupportedReason = 'update-server' | 'connect-host'

/** Plans on the host that runs the agents; a paired host plans its own disk, never this one's. */
export async function planBundledSkillsOnTarget(
  target: BundledSkillTarget,
  request: BundledSkillPlanRequest
): Promise<BundledSkillPlanResult> {
  if (target.kind === 'ssh') {
    return { kind: 'unsupported', reason: 'connect-host' }
  }
  if (target.kind !== 'environment') {
    const plan = await window.api.skills.bundledPlan(request)
    return { kind: 'plan', plan }
  }
  if (
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      BUNDLED_ORCA_SKILL_CAPABILITY
    ))
  ) {
    return { kind: 'unsupported', reason: 'update-server' }
  }
  const plan = await callRuntimeRpc<BundledSkillPlan>(
    { kind: 'environment', environmentId: target.environmentId },
    'skills.planBundledOrca',
    request,
    { timeoutMs: BUNDLED_SKILL_PLAN_TIMEOUT_MS }
  )
  return { kind: 'plan', plan }
}

/** Runs the plan `request` produced on `target`, identified by its digest. */
export function executeBundledSkillsOnTarget(
  target: BundledSkillTarget,
  planDigest: string,
  request: BundledSkillPlanRequest
): Promise<BundledSkillInstallResult> {
  if (target.kind === 'ssh') {
    return Promise.reject(new Error('skill-install-ssh-host-not-served'))
  }
  if (target.kind !== 'environment') {
    return window.api.skills.bundledExecute({
      planDigest,
      request
    })
  }
  return callRuntimeRpc<BundledSkillInstallResult>(
    { kind: 'environment', environmentId: target.environmentId },
    'skills.executeBundledOrca',
    { planDigest, request },
    { timeoutMs: BUNDLED_SKILL_EXECUTE_TIMEOUT_MS }
  )
}
