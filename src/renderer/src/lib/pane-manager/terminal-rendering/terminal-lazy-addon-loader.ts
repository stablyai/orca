// Memoize lazy xterm addon imports, expose resolved constructors synchronously, and drain panes opened during loading.
type LazyAddonLoadHandlers = {
  /** Attach the panes that opened while the load was still in flight. */
  onLoaded: () => void
  /** Latch those panes so they retry at a recovery boundary, not every frame. */
  onFailed?: () => void
}

export type LazyXtermAddonLoader<TConstructor> = {
  setHandlers: (next: LazyAddonLoadHandlers) => void
  getConstructor: () => TConstructor | null
  prime: () => Promise<void>
  /** Recovery boundary: let a load that hit the attempt cap try again. */
  rearm: () => void
}

/** Bound retries for missing deploy/disk chunks without letting one transient failure disable the addon for the session. */
const DEFAULT_ATTEMPT_LIMIT = 3

export function createLazyXtermAddonLoader<TConstructor>(config: {
  /** Keep the `import()` specifier literal in the caller so the bundler still splits the chunk. */
  load: () => Promise<TConstructor>
  failureMessage: string
  attemptLimit?: number
}): LazyXtermAddonLoader<TConstructor> {
  const attemptLimit = config.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT
  let constructor: TConstructor | null = null
  let load: Promise<void> | null = null
  let attempts = 0
  let handlers: LazyAddonLoadHandlers | null = null

  return {
    setHandlers: (next) => {
      handlers = next
    },
    getConstructor: () => constructor,
    prime: () => {
      if (constructor || load) {
        return load ?? Promise.resolve()
      }
      if (attempts >= attemptLimit) {
        return Promise.resolve()
      }
      attempts += 1
      load = config.load().then(
        (resolved) => {
          constructor = resolved
          handlers?.onLoaded()
        },
        (error) => {
          // then(onOk, onError) fulfills even on failure; clear its memo so later attaches can retry within the cap.
          load = null
          handlers?.onFailed?.()
          console.warn(config.failureMessage, error)
        }
      )
      return load
    },
    rearm: () => {
      if (constructor || load) {
        return
      }
      load = null
      attempts = 0
    }
  }
}
