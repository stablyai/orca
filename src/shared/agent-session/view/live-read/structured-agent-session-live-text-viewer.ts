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

export function createLiveTextViewerReport(
  viewer: StructuredAgentSessionLiveTextViewer | undefined
) {
  // What the current open's stream holds, or null before it is registered.
  const id = `${(viewers++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  let told: boolean | null = null
  let opened: boolean | null = null
  const tell = (): void => {
    if (!viewer || told === null) {
      return
    }
    const shown = viewer.shown()
    if (shown !== told) {
      told = shown
      void viewer.setShown(id, shown).catch(() => {})
    }
  }
  const stop = viewer?.subscribeShown(tell)
  return {
    id,
    /** The `shown` state for an open that asks for the viewer, or undefined for one that doesn't. */
    opening: (asksViewer: boolean): boolean | undefined => {
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
    dispose: (): void => stop?.()
  }
}
