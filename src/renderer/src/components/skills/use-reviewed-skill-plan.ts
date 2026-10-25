import { useEffect, useState } from 'react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { BUNDLED_ORCA_SKILL_UPDATE_REQUIRED_MESSAGE } from '../../../../shared/skill-install-capability'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { planBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'

type ReviewedPlan = { plan: BundledSkillPlan | null; loading: boolean; error: string | null }

type ForcedPlanResult = { request: string; plan: BundledSkillPlan | null; error: string | null }

/** Replan Replace choices through main with force paths; the renderer never edits operations and otherwise reuses the shared plan. */
export function useReviewedSkillPlan(
  target: BundledSkillTarget | null,
  sharedPlan: BundledSkillPlan | null,
  force: readonly string[]
): ReviewedPlan {
  // Why the shared digest: a re-check of the shared plan must re-plan the forced one too.
  const request =
    force.length > 0 && sharedPlan && target
      ? [bundledSkillTargetKey(target), sharedPlan.planDigest, ...force].join('\n')
      : ''
  const [result, setResult] = useState<ForcedPlanResult | null>(null)

  useEffect(() => {
    if (!request || !target) {
      return
    }
    let cancelled = false
    const forced = request.split('\n').slice(2)
    planBundledSkillsOnTarget(target, { force: forced }).then(
      (result) => {
        if (!cancelled) {
          setResult(
            result.kind === 'plan'
              ? { request, plan: result.plan, error: null }
              : { request, plan: null, error: BUNDLED_ORCA_SKILL_UPDATE_REQUIRED_MESSAGE }
          )
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({
            request,
            plan: null,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `request` names the target.
  }, [request])

  if (!request) {
    return { plan: sharedPlan, loading: false, error: null }
  }
  // Why: a result for an older toggle set is never shown as this one's.
  if (result?.request !== request) {
    return { plan: null, loading: true, error: null }
  }
  return { plan: result.plan, loading: false, error: result.error }
}
