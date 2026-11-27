/** A reader whose host sends it live text only while it says it is shown. */
export type StructuredAgentSessionLiveTextViewer = {
  /** Whether the host takes the viewer param and call; a rejection means no. */
  supported: Promise<boolean> | boolean
  shown: () => boolean
  /** Calls `changed` whenever `shown` may have changed; returns what stops listening. */
  subscribeShown: (changed: () => void) => () => void
  /** Tells the host, naming this read's viewer (one connection can carry several windows) and
   *  numbering the report, since reports can arrive out of order. */
  setShown: (viewerId: string, shown: boolean, seq: number) => Promise<unknown>
}

/** Keeps the host told whether this read's viewer is shown. An open carries the state in its
 *  capabilities; once that stream is registered (its first frame), each change goes out as a call. */
let viewers = 0

/** Random enough that no other client can guess it, from the platform's crypto where there is one. */
function randomViewerPart(): string {
  const bytes = new Uint8Array(12)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    bytes.forEach((_, index) => (bytes[index] = Math.floor(Math.random() * 256)))
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Retries of one failed report, each twice as long after the last; a later change starts over. */
const REPORT_RETRIES = 5
const REPORT_RETRY_MS = 1000

export function createLiveTextViewerReport(
  viewer: StructuredAgentSessionLiveTextViewer | undefined
) {
  const id = `${(viewers++).toString(36)}-${randomViewerPart()}`
  // What the current open's stream holds: null before it is registered, and 'unconfirmed' after a
  // report failed, when the host may hold either state, so the current one is always sent.
  let told: boolean | 'unconfirmed' | null = null
  let opened: boolean | null = null
  let seq = 0
  let retry: { timer: ReturnType<typeof setTimeout> | null; left: number } = {
    timer: null,
    left: REPORT_RETRIES
  }
  const cancelRetry = (): void => {
    if (retry.timer) {
      clearTimeout(retry.timer)
    }
    retry = { timer: null, left: REPORT_RETRIES }
  }
  const tell = (retrying = false): void => {
    if (!viewer || told === null) {
      return
    }
    const shown = viewer.shown()
    if (shown === told) {
      return
    }
    if (!retrying) {
      cancelRetry()
    }
    told = shown
    const attempt = retry
    viewer.setShown(id, shown, ++seq).catch(() => {
      if (attempt !== retry || told !== shown) {
        return
      }
      // Unconfirmed, so the host may still hold either state: say it again, a bounded number of
      // times, and send the current state on any later change.
      told = 'unconfirmed'
      if (attempt.left === 0) {
        return
      }
      const wait = REPORT_RETRY_MS * 2 ** (REPORT_RETRIES - attempt.left)
      attempt.left -= 1
      attempt.timer = setTimeout(() => {
        attempt.timer = null
        tell(true)
      }, wait)
    })
  }
  const stop = viewer?.subscribeShown(() => tell())
  return {
    id,
    /** The `shown` state for an open that asks for the viewer, or undefined for one that doesn't. */
    opening: (asksViewer: boolean): { shown: boolean; seq: number } | undefined => {
      cancelRetry()
      told = null
      opened = asksViewer && viewer ? viewer.shown() : null
      return opened === null ? undefined : { shown: opened, seq: ++seq }
    },
    registered: (): void => {
      if (opened !== null) {
        told = opened
        tell()
      }
    },
    dispose: (): void => {
      cancelRetry()
      stop?.()
    }
  }
}
