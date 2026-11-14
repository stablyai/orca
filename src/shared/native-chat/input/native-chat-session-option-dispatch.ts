import type {
  CatalogAgentInteractionDetection,
  CatalogCommandDelivery
} from '../../agent-session/options/agent-session-option-catalog-types'
import type { TerminalModelControlIntent } from './native-chat-terminal-model-control'

export type ClaudeModelSwitchOutcome = 'applied' | 'rejected' | 'unknown'

export type NativeChatSessionOptionDispatchResult =
  | { outcome?: ClaudeModelSwitchOutcome | 'dispatched' | 'picker-opened' }
  | {
      outcome: 'blocked'
      agent: string
      reason: 'foreign-draft' | 'target-unavailable' | 'unsupported-control' | 'admission'
    }

export type NativeChatSessionOptionDispatchOptions = {
  intent?: TerminalModelControlIntent
  detectAgentInteraction?: CatalogAgentInteractionDetection
  expectedChoiceLabel?: string
  delivery?: CatalogCommandDelivery
}

export type NativeChatSessionOptionDispatchCommand = (
  command: string,
  options?: NativeChatSessionOptionDispatchOptions
) =>
  | Promise<NativeChatSessionOptionDispatchResult | void>
  | NativeChatSessionOptionDispatchResult
  | void

/** Serialize absolute targets so they observe prior flips instead of stale baselines. */
export function createSerializedApplyQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
