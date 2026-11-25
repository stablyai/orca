import type { FleetWorkerOutcome } from './orchestration-fleet-outcome-resolution'

export const ORCHESTRATION_FLEET_ATTENTION_CATEGORIES = [
  'guidance',
  'input',
  'approval',
  'failure',
  'interruption',
  'stale',
  'unverifiable',
  'root_completion'
] as const

export type OrchestrationFleetAttentionCategory =
  (typeof ORCHESTRATION_FLEET_ATTENTION_CATEGORIES)[number]

export type OrchestrationFleetAttention = {
  categories: OrchestrationFleetAttentionCategory[]
  requiresAction: boolean
}

export type OrchestrationFleetAttentionFacts = {
  isRoot: boolean
  outcome?: FleetWorkerOutcome
  pendingInput?: boolean
  pendingGuidance?: boolean
  pendingApproval?: boolean
  interrupted?: boolean
  liveness: {
    verdict: 'live' | 'unverifiable' | 'exited'
    reason?: string
  }
}

const ACTION_CATEGORIES = new Set<string>([
  'guidance',
  'input',
  'approval',
  'failure',
  'interruption',
  'unverifiable'
] satisfies OrchestrationFleetAttentionCategory[])

export function isActionableOrchestrationFleetAttention(category: string): boolean {
  return ACTION_CATEGORIES.has(category)
}

export function projectOrchestrationFleetAttention(
  facts: OrchestrationFleetAttentionFacts
): OrchestrationFleetAttention {
  const categories: OrchestrationFleetAttentionCategory[] = []
  if (facts.pendingGuidance) {
    categories.push('guidance')
  }
  if (facts.pendingInput) {
    categories.push('input')
  }
  if (facts.pendingApproval) {
    categories.push('approval')
  }
  if (facts.outcome === 'failed') {
    categories.push('failure')
  }
  if (facts.interrupted) {
    categories.push('interruption')
  }
  // Unsupervised settled and handed-on dispatches have no process of their own to wait on; unverifiable adds no coordinator work.
  if (
    facts.liveness.verdict === 'unverifiable' &&
    facts.liveness.reason !== 'unsupervised_settled' &&
    facts.liveness.reason !== 'handed_on'
  ) {
    categories.push(facts.liveness.reason === 'stale_status' ? 'stale' : 'unverifiable')
  }
  // Proven exit must not also report absence and tell callers to keep waiting.
  if (
    facts.liveness.verdict !== 'exited' &&
    (facts.outcome === 'outcome_unknown' || facts.outcome === 'finished_unverified')
  ) {
    if (!categories.includes('unverifiable')) {
      categories.push('unverifiable')
    }
  }
  if (facts.isRoot && facts.outcome === 'succeeded') {
    categories.push('root_completion')
  }
  return {
    categories,
    requiresAction: categories.some((category) => ACTION_CATEGORIES.has(category))
  }
}

export function orchestrationFleetAttentionEqual(
  left: OrchestrationFleetAttention | undefined,
  right: OrchestrationFleetAttention | undefined
): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right || left.requiresAction !== right.requiresAction) {
    return false
  }
  return (
    left.categories.length === right.categories.length &&
    left.categories.every((category, index) => right.categories[index] === category)
  )
}
