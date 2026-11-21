import { normalizeHookPayload } from '../normalization/normalize-hook-payload'
import type { AgentHookEventPayload } from '../listener-event'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import type { HookListenerState } from '../listener-state'
import {
  pollAntigravityTranscriptStatus,
  readAntigravityTranscriptPoll,
  type AntigravityTranscriptPollReads
} from '../providers/antigravity/antigravity-transcript-poll'
import {
  pollCodexTranscriptStatus,
  readCodexTranscriptPoll,
  type CodexTranscriptPollReads
} from '../providers/codex/codex-transcript-poll'

export type HookTranscriptPollReads = {
  codex?: CodexTranscriptPollReads
  antigravity?: AntigravityTranscriptPollReads
}

export async function withHookTranscriptPoll(
  state: HookListenerState,
  paneKey: string,
  source: 'codex' | 'antigravity',
  live: () => boolean,
  consume: (reads: HookTranscriptPollReads) => void
): Promise<void> {
  if (!live()) {
    return
  }
  const reads =
    source === 'codex'
      ? { codex: await readCodexTranscriptPoll(state, paneKey, live) }
      : { antigravity: await readAntigravityTranscriptPoll(state, paneKey, live) }
  try {
    if (live()) {
      consume(reads)
    }
  } finally {
    reads.codex?.batch.release()
  }
}

export function normalizeHookTranscriptPoll(
  state: HookListenerState,
  {
    source,
    original,
    body
  }: { source: AgentHookSource; original: AgentHookEventPayload; body: unknown },
  env: string,
  reads?: HookTranscriptPollReads
): AgentHookEventPayload | null | undefined {
  return reads?.codex
    ? pollCodexTranscriptStatus(state, original, body, env, reads.codex)
    : source === 'antigravity'
      ? pollAntigravityTranscriptStatus(state, original, reads?.antigravity)
      : normalizeHookPayload(state, source, body, env)
}
