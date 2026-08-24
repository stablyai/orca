import type { AgentStatusOrchestrationContext } from './agent-status-types'

export type ParentLossObservation = Pick<
  AgentStatusOrchestrationContext,
  'parentStatus' | 'inputPolicy' | 'rebindStatus'
>

/**
 * Fail closed when an active worker's selected parent is no longer live.
 * This function is deliberately pure: C1 observes and freezes; C2 owns durable
 * checkpoint approval and rebind mutations.
 */
export function observeParentLoss(args: {
  dispatchActive: boolean
  parentSelected: boolean
  parentLive: boolean
}): ParentLossObservation {
  if (!args.dispatchActive || !args.parentSelected) {
    return {
      parentStatus: 'READY',
      inputPolicy: 'DIRECT_ALLOWED',
      rebindStatus: 'NOT_REQUIRED'
    }
  }
  if (args.parentLive) {
    return {
      parentStatus: 'READY',
      inputPolicy: 'PARENT_ONLY',
      rebindStatus: 'NOT_REQUIRED'
    }
  }
  return {
    parentStatus: 'FROZEN',
    inputPolicy: 'FROZEN',
    rebindStatus: 'APPROVAL_REQUIRED'
  }
}
