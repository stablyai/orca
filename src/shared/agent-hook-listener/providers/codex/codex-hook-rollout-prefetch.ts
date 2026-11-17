import { readFirstString } from '../../interactive-tool'
import { parseAgentHookJson } from '../../request-body'
import type { HookListenerState } from '../../listener-state'
import { readString } from '../../tool-input-preview'
import {
  createPrefetchedRolloutReads,
  prefetchJsonlCursor,
  prefetchRolloutHead,
  record,
  type PrefetchedRolloutReads
} from './codex-rollout-jsonl-cursor'
import { codexSubagentIdentityReadDue } from './codex-subagent-roster'
import {
  normalizedTranscriptPath,
  prefetchCodexSubagentTranscript
} from './codex-subagent-transcript'

// Mirrors parseHookEnvelope's reading so the prefetch keys match what normalization reads.
function hookPayload(body: unknown): Record<string, unknown> | undefined {
  const raw = record(body)?.payload
  if (typeof raw !== 'string') {
    return record(raw)
  }
  try {
    return record(parseAgentHookJson(raw))
  } catch {
    return undefined
  }
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
  if (transcriptPath && codexSubagentIdentityReadDue(roster, agentId, transcriptPath)) {
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
export async function prefetchCodexHookRolloutReadsWithin(
  state: HookListenerState,
  body: unknown
): Promise<PrefetchedRolloutReads> {
  const reads = createPrefetchedRolloutReads()
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HOOK_PREFETCH_MAX_MS)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    prefetchCodexHookRolloutReads(state, body, reads).then(done, done)
  })
  reads.closed = true
  return reads
}

/** Prefetches Codex hooks per pane in arrival order, so a slow read cannot let a later hook's status overtake an earlier one. */
export class CodexHookRolloutPrefetcher {
  private readonly tails = new Map<string, Promise<void>>()

  /** Call `release` once the hook is normalized and applied. */
  async prefetch(
    state: HookListenerState,
    body: unknown
  ): Promise<{ reads: PrefetchedRolloutReads; release: () => void }> {
    const key = hookPaneKey(body) ?? ''
    const previous = this.tails.get(key)
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = () => {
        if (this.tails.get(key) === turn) {
          this.tails.delete(key)
        }
        resolve()
      }
    })
    this.tails.set(key, turn)
    // Every turn's prefetch is time-bounded and its release follows synchronously, so the wait for `previous` is bounded too.
    await previous
    return { reads: await prefetchCodexHookRolloutReadsWithin(state, body), release }
  }
}
