import type { BundledSkillPlan, BundledSkillPlanEntry } from '../../../../shared/bundled-skill-plan'
import { isBundledSkillAutoUpdateOp } from '../../../../shared/bundled-skill-summary'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { autoUpdateBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'

// Why per skill and observed bytes: a failed or raced update re-plans identically and must fall back to the nudge, without blocking other skills.
const attempts = new Map<string, 'running' | 'settled'>()

function attemptKey(targetKey: string, entry: BundledSkillPlanEntry): string | null {
  const ops = entry.ops.filter(isBundledSkillAutoUpdateOp)
  if (ops.length === 0) {
    return null
  }
  const observed = ops.map((op) => [op.path, op.observed])
  return `${targetKey}:${entry.name}@${entry.digest}:${JSON.stringify(observed)}`
}

/**
 * Silently updates each skill's hash-verified Orca copies, at most once per observed state.
 * Returns the skills a running update owns, so the nudge asks only about the rest.
 */
export function autoUpdateUnmodifiedSkills(
  target: BundledSkillTarget,
  plan: BundledSkillPlan
): ReadonlySet<string> {
  const owned = new Set<string>()
  if (plan.scope !== 'global') {
    return owned
  }
  const targetKey = bundledSkillTargetKey(target)
  const started: string[] = []
  const keys: string[] = []
  for (const entry of plan.skills) {
    const key = attemptKey(targetKey, entry)
    const attempt = key ? attempts.get(key) : undefined
    if (!key || attempt === 'settled') {
      continue
    }
    owned.add(entry.name)
    if (!attempt) {
      attempts.set(key, 'running')
      started.push(entry.name)
      keys.push(key)
    }
  }
  if (started.length > 0) {
    // The host re-plans under its locks and re-checks each location right before writing.
    void autoUpdateBundledSkillsOnTarget(target, started)
      .catch(() => null)
      .finally(() => {
        for (const key of keys) {
          attempts.set(key, 'settled')
        }
        notifyInstalledAgentSkillsChanged()
      })
  }
  return owned
}

/** @internal - tests need a clean module between cases. */
export function _resetSkillFreshnessAutoUpdate(): void {
  attempts.clear()
}
