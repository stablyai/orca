// Shared shape for xterm addons Orca keeps off the boot chunk: memoize the
// dynamic import, expose the resolved constructor synchronously to later panes,
// and drain the panes that opened while the load was in flight.
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

// Why a cap rather than unlimited retries: a chunk that is genuinely gone (bad
// deploy, unreadable disk) must not re-fetch on every attach, but one transient
// failure must not disable the addon for the whole session either.
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
          // Why clear the memo: `.then(onOk, onError)` settles *fulfilled*, so
          // caching it would disable the addon for the rest of the session even
          // though a later attach could retry within the attempt cap.
          load = null
          handlers?.onFailed?.()
          console.warn(config.failureMessage, error)
        }
      )
      return load
    },
    rearm: () => {
      if (constructor) {
        return
      }
      load = null
      attempts = 0
    }
  }
}
