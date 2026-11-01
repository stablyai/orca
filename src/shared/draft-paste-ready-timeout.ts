import type { TuiAgent } from './tui-agent'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from './generated-agent-input-readiness'

export function resolveDraftPasteReadyTimeoutMs(_agent?: TuiAgent, overrideMs?: number): number {
  return overrideMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS
}
