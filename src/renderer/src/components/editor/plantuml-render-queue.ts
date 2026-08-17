// Why: the engine keeps parse/layout state in module-level globals (TeaVM statics
// plus the shared Viz instance), so concurrent renders interleave and can emit one
// diagram's SVG for another's source. Every render goes through one chain.
let renderQueue: Promise<void> = Promise.resolve()

/**
 * Runs `fn` after every previously enqueued render has settled, so no two
 * renders touch the engine's global state at once.
 */
export function enqueuePlantUmlRender(fn: () => Promise<void>): void {
  const next = renderQueue.then(fn, fn)
  renderQueue = next
  // Why collapse the chain: the tail would otherwise keep every earlier .then()
  // closure reachable, and those capture diagram source for the lifetime of the
  // renderer. Why the identity check: resetting unconditionally would overwrite a
  // newer pending chain, letting the render after it start early and run
  // concurrently with one still in flight.
  void next.then(
    () => {
      if (renderQueue === next) {
        renderQueue = Promise.resolve()
      }
    },
    () => {
      if (renderQueue === next) {
        renderQueue = Promise.resolve()
      }
    }
  )
}
