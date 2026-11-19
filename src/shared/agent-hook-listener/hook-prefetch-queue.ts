import { parseHookPayloadForPrefetch } from './hook-envelope'
import { readFirstString } from './interactive-tool'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

// Mirrors parseHookEnvelope's reading so prefetch keys match what normalization reads; the parse is handed to it.
export function prefetchHookPayload(body: unknown): Record<string, unknown> | undefined {
  const envelope = record(body)
  const raw = envelope?.payload
  return envelope && typeof raw === 'string'
    ? record(parseHookPayloadForPrefetch(envelope, raw))
    : record(raw)
}

export function prefetchHookPaneKey(body: unknown): string | undefined {
  const paneKey = record(body)?.paneKey
  return typeof paneKey === 'string' && paneKey.trim() ? paneKey.trim() : undefined
}

export function prefetchHookEventName(
  body: unknown,
  payload: Record<string, unknown>
): string | undefined {
  return (
    readFirstString(record(body) ?? {}, [
      'hook_event_name',
      'hookEventName',
      'hook_type',
      'hookType'
    ]) ?? readFirstString(payload, ['hook_event_name', 'hookEventName'])
  )
}

// Why: longer than the multi-second opens on-access scans cause, so a hung open, not a slow one, is what gets cut off.
const HOOK_PREFETCH_MAX_MS = 20_000

/** Waits for a hook's prefetch within the time bound; the caller closes it so pending reads start nothing further. */
export async function settlePrefetchWithin(prefetch: Promise<unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, HOOK_PREFETCH_MAX_MS)
    timer.unref?.()
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    prefetch.then(done, done)
  })
}

/** Prefetches hooks per pane in arrival order, so a slow read cannot let a later hook's status overtake an earlier one. */
export class HookPrefetchQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /** `read` must be time-bounded; call `release` once the hook is normalized and applied. */
  async prefetch<T>(
    body: unknown,
    read: () => Promise<T>
  ): Promise<{ value: T; release: () => void }> {
    const key = prefetchHookPaneKey(body) ?? ''
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
    // Every turn's read is time-bounded and its release follows synchronously, so the wait for `previous` is bounded too.
    await previous
    try {
      return { value: await read(), release }
    } catch (error) {
      release()
      throw error
    }
  }
}
