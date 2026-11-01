import { toast } from 'sonner'
import type {
  BundledSkillInstallResult,
  BundledSkillPlan,
  BundledSkillPlanEntry
} from '../../../../shared/bundled-skill-plan'
import { isBundledSkillAutoUpdateOp } from '../../../../shared/bundled-skill-summary'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { translate } from '@/i18n/i18n'
import { autoUpdateBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'
import { getSkillUpdateRun, runAutomaticSkillUpdate } from './skill-update-run-store'

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

/** A write that raced the update is kept as a backup; never let that pass as a silent success. */
function reportPreservedEdits(result: BundledSkillInstallResult | null): void {
  for (const skill of result?.skills ?? []) {
    for (const op of skill.ops) {
      if (!op.backupPath) {
        continue
      }
      toast.warning(
        translate(
          'auto.components.skills.skillFreshnessAutoUpdate.preservedTitle',
          'Your edits to {{value0}} were saved separately',
          { value0: skill.name }
        ),
        {
          description: translate(
            'auto.components.skills.skillFreshnessAutoUpdate.preservedDescription',
            'Orca updated the skill and saved your edits to {{value0}}.',
            { value0: op.backupPath }
          ),
          duration: Number.POSITIVE_INFINITY
        }
      )
    }
  }
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
  // A manual update owns the target; its re-plan decides what is left.
  const canStart = getSkillUpdateRun(targetKey).state !== 'running'
  const started: string[] = []
  const keys: string[] = []
  for (const entry of plan.skills) {
    const key = attemptKey(targetKey, entry)
    const attempt = key ? attempts.get(key) : undefined
    if (!key || attempt === 'settled' || (!attempt && !canStart)) {
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
    void runAutomaticSkillUpdate(target, started, () =>
      autoUpdateBundledSkillsOnTarget(target, started)
    )
      .then((ran) => reportPreservedEdits(ran?.value ?? null))
      .catch(() => undefined)
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
