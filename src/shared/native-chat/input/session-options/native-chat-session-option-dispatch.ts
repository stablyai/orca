import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'

export type ClaudeModelSwitchOutcome = 'applied' | 'rejected' | 'unknown'

export type NativeChatSessionOptionDispatchResult = {
  outcome?: ClaudeModelSwitchOutcome
}

export type NativeChatSessionOptionDispatchCommand = (
  command: string,
  options?: {
    detectAgentInteraction?: CatalogAgentInteractionDetection
    expectedChoiceLabel?: string
    delivery?: CatalogCommandDelivery
    /** Let queued chat sends go first instead of cancelling them. */
    afterQueuedSends?: boolean
  }
) =>
  | Promise<NativeChatSessionOptionDispatchResult | void>
  | NativeChatSessionOptionDispatchResult
  | void
