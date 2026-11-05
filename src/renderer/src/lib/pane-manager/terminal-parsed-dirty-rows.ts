/** Track xterm’s own parse-dirty viewport spans for immediate foreground repair. Full-grid repair widens the render debouncer’s union, turning narrow TUI redraws into whole-grid cell scans. */
export type ParsedDirtyRowSpan = { start: number; end: number }

type RequestRefreshRowsEvent = { start: number; end: number } | undefined

/** Key by terminal identity while accepting callers’ partial views; private parse signals remain defensive probes, never type requirements. */
export type ParsedDirtyRowTerminal = WeakKey

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

// Null preserves full-grid repair when parse spans are unobservable.
const trackersByTerminal = new WeakMap<ParsedDirtyRowTerminal, ParsedDirtyRowTracker | null>()

function attachTracker(terminal: ParsedDirtyRowTerminal): ParsedDirtyRowTracker | null {
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
export function resetParsedDirtyRows(terminal: ParsedDirtyRowTerminal): void {
  const tracker = attachTracker(terminal)
  if (!tracker) {
    return
  }
  tracker.observed = false
  tracker.wholeViewport = false
  tracker.start = 0
  tracker.end = 0
}

/** Union since reset, or null for absent/unobservable spans or xterm full-refresh requests; callers must then repaint everything. */
export function readParsedDirtyRowSpan(
  terminal: ParsedDirtyRowTerminal
): ParsedDirtyRowSpan | null {
  const tracker = trackersByTerminal.get(terminal)
  if (!tracker || !tracker.observed || tracker.wholeViewport) {
    return null
  }
  return { start: tracker.start, end: tracker.end }
}

export function disposeParsedDirtyRows(terminal: ParsedDirtyRowTerminal): void {
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
