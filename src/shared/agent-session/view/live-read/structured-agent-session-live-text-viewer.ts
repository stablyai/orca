/** A reader whose host sends it live text only while it says it is shown. */
export type StructuredAgentSessionLiveTextViewer = {
  /** Whether the host takes the viewer param and call; a rejection means no. */
  supported: Promise<boolean> | boolean
  shown: () => boolean
  /** Calls `changed` whenever `shown` may have changed; returns what stops listening. */
  subscribeShown: (changed: () => void) => () => void
  /** Tells the host, naming this read's viewer: one connection can carry several windows. */
  setShown: (viewerId: string, shown: boolean) => Promise<unknown>
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
  // What the current open's stream holds, or null before it is registered.
  const id = `${(viewers++).toString(36)}-${randomViewerPart()}`
  let told: boolean | null = null
  let opened: boolean | null = null
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
    viewer.setShown(id, shown).catch(() => {
      // Unconfirmed, so the host may still hold the old state: say it again, a bounded number of times.
      if (attempt !== retry || told !== shown || attempt.left === 0) {
        return
      }
      told = !shown
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
    opening: (asksViewer: boolean): boolean | undefined => {
      cancelRetry()
      told = null
      opened = asksViewer && viewer ? viewer.shown() : null
      return opened ?? undefined
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
