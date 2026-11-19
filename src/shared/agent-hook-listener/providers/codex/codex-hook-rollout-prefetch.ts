import { readFirstString } from '../../interactive-tool'
import {
  prefetchHookEventName,
  prefetchHookPaneKey,
  prefetchHookPayload,
  settlePrefetchWithin
} from '../../hook-prefetch-queue'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'
import {
  createPrefetchedRolloutReads,
  type PrefetchedRolloutReads,
  prefetchJsonlCursor,
  prefetchRolloutHead
} from './codex-rollout-prefetch-scope'
import { codexSubagentIdentityReadDue } from './codex-subagent-roster'
import { readsIdentity } from './codex-subagent-identity'
import { normalizedTranscriptPath } from './codex-rollout-paths'
import { prefetchCodexSubagentTranscript } from './codex-subagent-transcript-reads'

async function prefetchParent(
  reads: PrefetchedRolloutReads,
  state: HookListenerState,
  paneKey: string,
  parentPath: string | undefined
): Promise<void> {
  const path = normalizedTranscriptPath(parentPath)
  if (!path) {
    return
  }
  const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (transcript?.parent.filePath === path) {
    await prefetchCodexSubagentTranscript(transcript, reads)
    return
  }
  // A new or replaced parent rollout is read from the top.
  await prefetchJsonlCursor(reads, { filePath: path, offset: 0, carry: '' })
}

/** Reads off the main thread the rollouts this Codex hook's normalization would read, so it never opens a live rollout synchronously (#43539). */
export async function prefetchCodexHookRolloutReads(
  state: HookListenerState,
  body: unknown,
  reads: PrefetchedRolloutReads = createPrefetchedRolloutReads()
): Promise<PrefetchedRolloutReads> {
  const paneKey = prefetchHookPaneKey(body)
  const payload = prefetchHookPayload(body)
  if (!paneKey || !payload) {
    return reads
  }
  const eventName = prefetchHookEventName(body, payload)
  const agentId = readString(payload, 'agent_id')
  const transcriptPath = readFirstString(payload, ['transcript_path', 'transcriptPath'])
  const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (!agentId) {
    // A root SessionStart resets the pane and reads nothing.
    if (eventName !== 'SessionStart') {
      await prefetchParent(reads, state, paneKey, transcriptPath)
    }
    return reads
  }
  const roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  if (
    transcriptPath &&
    readsIdentity(transcriptPath) &&
    codexSubagentIdentityReadDue(roster, agentId, transcriptPath)
  ) {
    await prefetchRolloutHead(reads, transcriptPath, (size) =>
      codexSubagentIdentityReadDue(roster, agentId, transcriptPath, size)
    )
  }
  if (eventName === 'SubagentStart') {
    const parentPath =
      transcript?.parent.filePath ??
      state.lastStatusByPaneKey.get(paneKey)?.providerSession?.transcriptPath
    await prefetchParent(reads, state, paneKey, parentPath)
  } else if (eventName === 'PermissionRequest' && transcriptPath) {
    if (transcript?.parent.filePath === transcriptPath) {
      await prefetchParent(reads, state, paneKey, transcriptPath)
    } else {
      const path = normalizedTranscriptPath(transcriptPath)
      const cursor = path
        ? (transcript?.reviewerCursorsByPath.get(path) ?? { filePath: path, offset: 0, carry: '' })
        : undefined
      if (cursor) {
        await prefetchJsonlCursor(reads, cursor)
      }
    }
  }
  return reads
}

/** Prefetches within a time bound; reads still pending afterwards are deferred to the poll and start nothing further. */
export async function prefetchCodexHookRolloutReadsWithin(
  state: HookListenerState,
  body: unknown
): Promise<PrefetchedRolloutReads> {
  const reads = createPrefetchedRolloutReads()
  await settlePrefetchWithin(prefetchCodexHookRolloutReads(state, body, reads))
  reads.closed = true
  return reads
}
