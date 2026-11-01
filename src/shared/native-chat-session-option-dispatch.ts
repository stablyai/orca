import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from './agent-session/options/agent-session-option-catalog-types'

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
  }
) =>
  | Promise<NativeChatSessionOptionDispatchResult | void>
  | NativeChatSessionOptionDispatchResult
  | void
