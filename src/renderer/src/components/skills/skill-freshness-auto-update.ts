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
import { useAppStore } from '@/store'
import { getSkillUpdateRun, runAutomaticSkillUpdate } from './skill-update-run-store'

// Why per skill and observed bytes: a failed or raced update re-plans identically and must fall back to the nudge, without blocking other skills.
type AttemptState = 'running' | 'settled'
// Keyed by target; each scan prunes what it no longer observes, so the map stays plan-sized.
const attemptsByTarget = new Map<string, Map<string, AttemptState>>()

/** Drop settled attempts for states this scan no longer sees; running ones still own their skills. */
function pruneAttempts(targetKey: string, liveKeys: ReadonlySet<string>): void {
  for (const [key, attempts] of attemptsByTarget) {
    for (const [attemptKey, state] of attempts) {
      if (state === 'settled' && (key !== targetKey || !liveKeys.has(attemptKey))) {
        attempts.delete(attemptKey)
      }
    }
    if (attempts.size === 0 && key !== targetKey) {
      attemptsByTarget.delete(key)
    }
  }
}

function attemptKey(targetKey: string, entry: BundledSkillPlanEntry): string | null {
  const ops = entry.ops.filter(isBundledSkillAutoUpdateOp)
  if (ops.length === 0) {
    return null
  }
  const observed = ops.map((op) => [op.path, op.observed])
  return `${targetKey}:${entry.name}@${entry.digest}:${JSON.stringify(observed)}`
}

function warnAboutEdits(title: string, description: string): void {
  toast.warning(title, { description, duration: Number.POSITIVE_INFINITY })
}

/** A write that raced the update is kept aside; never let that pass as a silent success. */
function reportPreservedEdits(result: BundledSkillInstallResult | null): void {
  for (const skill of result?.skills ?? []) {
    for (const op of skill.ops) {
      if (op.strandedPath) {
        warnAboutEdits(
          translate(
            'auto.components.skills.skillFreshnessAutoUpdate.strandedTitle',
            "Orca couldn't back up your edits to {{value0}}",
            { value0: skill.name }
          ),
          translate(
            'auto.components.skills.skillFreshnessAutoUpdate.strandedDescription',
            'Your edits are still in {{value0}}. Copy them somewhere safe before updating again.',
            { value0: op.strandedPath }
          )
        )
      } else if (op.backupPath) {
        warnAboutEdits(
          translate(
            'auto.components.skills.skillFreshnessAutoUpdate.preservedTitle',
            'Your edits to {{value0}} were saved separately',
            { value0: skill.name }
          ),
          translate(
            'auto.components.skills.skillFreshnessAutoUpdate.preservedDescription',
            'Orca updated the skill and saved your edits to {{value0}}.',
            { value0: op.backupPath }
          )
        )
      }
    }
  }
}

function targetLabel(target: BundledSkillTarget): string {
  if (target.kind === 'local') {
    return translate('auto.components.skills.host.local', 'This machine')
  }
  const environment =
    target.kind === 'environment'
      ? useAppStore
          .getState()
          .runtimeEnvironments.find((candidate) => candidate.id === target.environmentId)
      : undefined
  return environment?.name ?? translate('auto.components.skills.host.remote', 'Connected runtime')
}

/** The host-side folder where the executor preserves edits that raced a swap. */
function skillBackupDirectory(homeDirectory: string): string {
  const separator = /^[a-z]:[\\/]|^\\\\/iu.test(homeDirectory) ? '\\' : '/'
  const home = homeDirectory.replace(/[\\/]+$/u, '')
  return [home, '.agents', '.orca-skill-backups'].join(separator)
}

/** A lost or timed-out reply may follow a committed swap, so its backups must not go unmentioned. */
function reportUncertainOutcome(target: BundledSkillTarget, plan: BundledSkillPlan): void {
  warnAboutEdits(
    translate(
      'auto.components.skills.skillFreshnessAutoUpdate.uncertainTitle',
      "Orca couldn't confirm the skill update on {{value0}}",
      { value0: targetLabel(target) }
    ),
    translate(
      'auto.components.skills.skillFreshnessAutoUpdate.uncertainDescription',
      "Orca may have updated skills on {{value0}} but couldn't confirm the result. If you edited a skill during the update, your copy is in {{value1}}.",
      { value0: targetLabel(target), value1: skillBackupDirectory(plan.homeDirectory) }
    )
  )
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
  // A manual update or its unacknowledged result owns the target; the nudge covers the rest meanwhile.
  const canStart = getSkillUpdateRun(targetKey).state === 'idle'
  const entries = plan.skills.map((entry) => ({ entry, key: attemptKey(targetKey, entry) }))
  pruneAttempts(targetKey, new Set(entries.flatMap(({ key }) => (key ? [key] : []))))
  let attempts = attemptsByTarget.get(targetKey)
  if (!attempts) {
    attempts = new Map()
    attemptsByTarget.set(targetKey, attempts)
  }
  const started: string[] = []
  const keys: string[] = []
  for (const { entry, key } of entries) {
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
      .then(
        (ran) => reportPreservedEdits(ran?.value ?? null),
        // Settling the keys below means the same state is never retried; the nudge takes over.
        () => reportUncertainOutcome(target, plan)
      )
      .catch(() => undefined)
      .finally(() => {
        const settled = attemptsByTarget.get(targetKey) ?? new Map<string, AttemptState>()
        attemptsByTarget.set(targetKey, settled)
        for (const key of keys) {
          settled.set(key, 'settled')
        }
        notifyInstalledAgentSkillsChanged()
      })
  }
  return owned
}

/** @internal - tests need a clean module between cases. */
export function _resetSkillFreshnessAutoUpdate(): void {
  attemptsByTarget.clear()
}

/** @internal - lets tests prove the attempt map stays bounded. */
export function _skillFreshnessAutoUpdateAttemptCount(): number {
  return [...attemptsByTarget.values()].reduce((total, attempts) => total + attempts.size, 0)
}
