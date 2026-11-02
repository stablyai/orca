import { getMaxTerminalPasteBytesForIngestMs } from './agent-prompt-injection'
import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
} from './orchestration-timing-budgets'
import {
  isTerminalInputTooLargeWithYield,
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES
} from './terminal-input'

const WORKER_START_PROMPT_INGEST_BUDGET_MS =
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS - AGENT_PROMPT_EFFECT_TIMEOUT_MS
const WORKER_START_PREAMBLE_RESERVED_BYTES = TERMINAL_INPUT_CHUNK_MAX_BYTES * 4

/** Keeps worst-case Windows ingest plus effect settlement inside worker-start's fixed RPC grace. */
export const ORCHESTRATION_WORKER_START_PROMPT_MAX_BYTES = Math.min(
  TERMINAL_INPUT_MAX_BYTES,
  getMaxTerminalPasteBytesForIngestMs('win32', WORKER_START_PROMPT_INGEST_BUDGET_MS)
)

/** Task body limit; the remaining prompt budget is reserved for Orca's fixed dispatch preamble. */
export const ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES =
  ORCHESTRATION_WORKER_START_PROMPT_MAX_BYTES - WORKER_START_PREAMBLE_RESERVED_BYTES

export function isWorkerStartTaskSpecTooLarge(spec: string): Promise<boolean> {
  return isTerminalInputTooLargeWithYield(spec, ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES)
}
