import type { HookListenerState } from '../listener-state'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import {
  readCodexTranscriptPoll,
  type CodexTranscriptPollReads
} from '../providers/codex/codex-transcript-poll'
import { refreshDroidTurnOutcome } from '../providers/droid/droid-turn-outcome'

/** Transcript reads a poll needs before it replays its hook, kept off the main thread (#43539). */
export async function readHookTranscriptPoll(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string
): Promise<CodexTranscriptPollReads | undefined> {
  if (source === 'codex') {
    return readCodexTranscriptPoll(state, paneKey)
  }
  await refreshDroidTurnOutcome(state, paneKey)
  return undefined
}
