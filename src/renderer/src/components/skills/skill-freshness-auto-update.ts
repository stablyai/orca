import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { bundledSkillPlanAutoUpdates } from '../../../../shared/bundled-skill-summary'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { executeBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'

// Why per plan digest: a run that failed or raced leaves the same plan, which must fall back to the nudge instead of looping.
const attempts = new Map<string, 'running' | 'settled'>()

/**
 * Silently applies a plan whose only writes replace hash-verified Orca releases.
 * Returns true while that run owns the plan, so callers suppress the consent nudge.
 */
export function autoUpdateUnmodifiedSkills(
  target: BundledSkillTarget,
  plan: BundledSkillPlan
): boolean {
  if (!bundledSkillPlanAutoUpdates(plan)) {
    return false
  }
  const key = `${bundledSkillTargetKey(target)}:${plan.planDigest}`
  const attempt = attempts.get(key)
  if (attempt) {
    return attempt === 'running'
  }
  attempts.set(key, 'running')
  // Execute re-plans and refuses ops whose disk state changed since this plan, so edits made meanwhile survive.
  void executeBundledSkillsOnTarget(target, plan.planDigest, {})
    .catch(() => undefined)
    .finally(() => {
      attempts.set(key, 'settled')
      notifyInstalledAgentSkillsChanged()
    })
  return true
}

/** @internal - tests need a clean module between cases. */
export function _resetSkillFreshnessAutoUpdate(): void {
  attempts.clear()
}
