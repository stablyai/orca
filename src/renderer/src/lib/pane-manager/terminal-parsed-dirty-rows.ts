/**
 * The viewport row span xterm itself marked dirty while parsing the writes made
 * since the last reset.
 *
 * Why: xterm's InputHandler already tracks exactly which viewport rows a parse
 * touched and asks the terminal to repaint them (`onRequestRefreshRows`). Orca's
 * foreground settle re-issues that repaint so an in-place agent redraw is painted
 * now instead of a frame later. Re-issuing it as `0..rows-1` widened every
 * repaint to the whole grid — xterm's render debouncer unions ranges, so one
 * full-grid request turns a five-row frame into a whole-viewport `_updateModel`
 * pass over every cell. Observing the parse's own dirty span keeps the repair
 * and drops the widening.
 */
export type ParsedDirtyRowSpan = { start: number; end: number }

type RequestRefreshRowsEvent = { start: number; end: number } | undefined

type ParsedDirtyRowSource = {
  _core?: {
    _inputHandler?: {
      onRequestRefreshRows?: (listener: (event: RequestRefreshRowsEvent) => void) => {
        dispose: () => void
      }
    }
  }
}

type ParsedDirtyRowTracker = {
  start: number
  end: number
  observed: boolean
  wholeViewport: boolean
  dispose: () => void
}

// `null` marks a terminal whose parse spans cannot be observed, so callers keep
// the full-grid behavior instead of narrowing on an absent signal.
const trackersByTerminal = new WeakMap<object, ParsedDirtyRowTracker | null>()

function attachTracker(terminal: object): ParsedDirtyRowTracker | null {
  const existing = trackersByTerminal.get(terminal)
  if (existing !== undefined) {
    return existing
  }
  const subscribe = (terminal as ParsedDirtyRowSource)._core?._inputHandler?.onRequestRefreshRows
  const inputHandler = (terminal as ParsedDirtyRowSource)._core?._inputHandler
  if (typeof subscribe !== 'function' || !inputHandler) {
    trackersByTerminal.set(terminal, null)
    return null
  }
  const tracker: ParsedDirtyRowTracker = {
    start: 0,
    end: 0,
    observed: false,
    wholeViewport: false,
    dispose: () => {}
  }
  try {
    const subscription = subscribe.call(inputHandler, (event) => {
      if (!event) {
        // xterm asks for a whole-viewport repaint by firing `undefined`.
        tracker.wholeViewport = true
        tracker.observed = true
        return
      }
      if (!tracker.observed) {
        tracker.start = event.start
        tracker.end = event.end
        tracker.observed = true
        return
      }
      tracker.start = Math.min(tracker.start, event.start)
      tracker.end = Math.max(tracker.end, event.end)
    })
    tracker.dispose = () => subscription.dispose()
  } catch {
    trackersByTerminal.set(terminal, null)
    return null
  }
  trackersByTerminal.set(terminal, tracker)
  return tracker
}

/** Start (or reset) parse-span observation for the write that is about to run. */
export function resetParsedDirtyRows(terminal: object): void {
  const tracker = attachTracker(terminal)
  if (!tracker) {
    return
  }
  tracker.observed = false
  tracker.wholeViewport = false
  tracker.start = 0
  tracker.end = 0
}

/**
 * The union of parse spans since the last reset, or `null` when the span is
 * unknown (unobservable terminal, no parse seen, or an xterm full-refresh
 * request) and the caller must repaint the whole viewport.
 */
export function readParsedDirtyRowSpan(terminal: object): ParsedDirtyRowSpan | null {
  const tracker = trackersByTerminal.get(terminal)
  if (!tracker || !tracker.observed || tracker.wholeViewport) {
    return null
  }
  return { start: tracker.start, end: tracker.end }
}

export function disposeParsedDirtyRows(terminal: object): void {
  const tracker = trackersByTerminal.get(terminal)
  if (tracker) {
    try {
      tracker.dispose()
    } catch {
      // A disposed terminal has already torn its emitters down.
    }
  }
  trackersByTerminal.delete(terminal)
}
