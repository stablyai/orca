import { readFirstString } from '../../interactive-tool'
import { parseHookPayloadForPrefetch } from '../../hook-envelope'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'
import { record } from './codex-rollout-jsonl-format'
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

// Mirrors parseHookEnvelope's reading so the prefetch keys match what normalization reads; the parse is handed to it.
function hookPayload(body: unknown): Record<string, unknown> | undefined {
  const envelope = record(body)
  const raw = envelope?.payload
  return envelope && typeof raw === 'string'
    ? record(parseHookPayloadForPrefetch(envelope, raw))
    : record(raw)
}

function hookPaneKey(body: unknown): string | undefined {
  const paneKey = record(body)?.paneKey
  return typeof paneKey === 'string' && paneKey.trim() ? paneKey.trim() : undefined
}

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
  const paneKey = hookPaneKey(body)
  const payload = hookPayload(body)
  if (!paneKey || !payload) {
    return reads
  }
  const eventName =
    readFirstString(record(body) ?? {}, [
      'hook_event_name',
      'hookEventName',
      'hook_type',
      'hookType'
    ]) ?? readFirstString(payload, ['hook_event_name', 'hookEventName'])
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

// Why: longer than the multi-second opens on-access scans cause, so a hung open, not a slow one, is what gets cut off.
const HOOK_PREFETCH_MAX_MS = 20_000

/** Prefetches within a time bound; reads still pending afterwards are deferred to the poll and start nothing further. */
async function prefetchCodexHookRolloutReadsWithin(
  state: HookListenerState,
  body: unknown,
  owner: AbortSignal
): Promise<PrefetchedRolloutReads> {
  const controller = new AbortController()
  const reads = createPrefetchedRolloutReads(AbortSignal.any([controller.signal, owner]))
  if (owner.aborted) {
    reads.closed = true
    return reads
  }
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      owner.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, HOOK_PREFETCH_MAX_MS)
    timer.unref?.()
    owner.addEventListener('abort', done, { once: true })
    prefetchCodexHookRolloutReads(state, body, reads).then(done, done)
  })
  reads.closed = true
  controller.abort()
  return reads
}

/** Prefetches Codex hooks per pane in arrival order, so a slow read cannot let a later hook's status overtake an earlier one. */
export class CodexHookRolloutPrefetcher {
  private readonly tails = new Map<string, { turn: Promise<void>; owner: AbortController }>()

  clear(paneKey: string): void {
    const tail = this.tails.get(paneKey)
    this.tails.delete(paneKey)
    tail?.owner.abort()
  }

  clearAll(): void {
    for (const paneKey of this.tails.keys()) {
      this.clear(paneKey)
    }
  }

  /** Call `release` once the hook is normalized and applied. */
  async prefetch(
    state: HookListenerState,
    body: unknown
  ): Promise<{ reads: PrefetchedRolloutReads; signal: AbortSignal; release: () => void }> {
    const key = hookPaneKey(body) ?? ''
    const previous = this.tails.get(key)
    const owner = previous?.owner ?? new AbortController()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = () => {
        if (this.tails.get(key)?.turn === turn) {
          this.tails.delete(key)
        }
        resolve()
      }
    })
    this.tails.set(key, { turn, owner })
    // Every turn's prefetch is time-bounded and its release follows synchronously, so the wait for `previous` is bounded too.
    await previous?.turn
    const reads = await prefetchCodexHookRolloutReadsWithin(state, body, owner.signal)
    return {
      reads,
      signal: owner.signal,
      release: () => {
        reads.batch.release()
        release()
      }
    }
  }
}
