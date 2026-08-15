import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from '../../../../shared/agent-session-option-catalog'
import type { ClaudeModelSwitchOutcome } from './claude-model-switch-confirmation'
import type { ClaudePermissionModeCycleResult } from './claude-permission-mode-cycle'

export type NativeChatSessionOptionDispatchResult = {
  outcome?: ClaudeModelSwitchOutcome
}

export type NativeChatModeCycleDispatch = (args: {
  key: string
  target: string
}) => Promise<ClaudePermissionModeCycleResult>

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
