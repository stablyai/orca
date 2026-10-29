/// <reference types="vite/client" />

import realKimiPrOutput from './official-kimi-2.3.1-real-pr.jsonl?raw'
import realKimiOccupiedOutput from './official-kimi-2.3.1-session-occupied.jsonl?raw'

// Official 2.3.1 at a830615, existing Responses backend; only session/lock identifiers redacted.
export { realKimiPrOutput, realKimiOccupiedOutput }

// Synthetic answer variants; only the unmodified exports above are actual captures.
export function sourceShapedKimiOutput(content?: string): string {
  return content === undefined
    ? realKimiPrOutput.trimEnd().split('\n').slice(0, 4).join('\n')
    : JSON.stringify({ role: 'assistant', content })
}
