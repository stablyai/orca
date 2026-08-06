import type { CatalogAgentInteractionDetection } from '../../../../shared/agent-session-option-catalog'
import type { ClaudeModelSwitchOutcome } from './claude-model-switch-confirmation'

export type NativeChatSessionOptionDispatchResult = {
  outcome?: ClaudeModelSwitchOutcome
}

export type NativeChatSessionOptionDispatchCommand = (
  command: string,
  options?: {
    detectAgentInteraction?: CatalogAgentInteractionDetection
    expectedChoiceLabel?: string
  }
) =>
  | Promise<NativeChatSessionOptionDispatchResult | void>
  | NativeChatSessionOptionDispatchResult
  | void
