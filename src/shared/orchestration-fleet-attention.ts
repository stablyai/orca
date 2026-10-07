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
  outcome?: 'in_progress' | 'succeeded' | 'failed' | 'outcome_unknown' | 'finished_unverified'
  pendingInput?: boolean
  pendingGuidance?: boolean
  pendingApproval?: boolean
  interrupted?: boolean
  liveness: {
    verdict: 'live' | 'unverifiable' | 'exited'
    reason?: string
  }
}

const ACTION_CATEGORIES = new Set<OrchestrationFleetAttentionCategory>([
  'guidance',
  'input',
  'approval',
  'failure',
  'interruption',
  'unverifiable'
])

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
  // A Dispatch that settled with no worker row has no process to wait on, so its unverifiable
  // verdict is a statement about supervision that never existed, not work owed to a coordinator.
  if (
    facts.liveness.verdict === 'unverifiable' &&
    facts.liveness.reason !== 'unsupervised_settled'
  ) {
    categories.push(facts.liveness.reason === 'stale_status' ? 'stale' : 'unverifiable')
  }
  // A proven exit is evidence, not absence: `unverifiable` beside an `exited` verdict told a
  // reader to keep waiting on a worker the execution host had already reported gone.
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
