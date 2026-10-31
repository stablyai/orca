import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from './agent-session-option-catalog'

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
