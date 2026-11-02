import { e2eConfig } from '@/lib/e2e-config'

/** Facts read on demand carry no revision. */
export type SidebarShadowMainRead<Value> = { revision?: number; values: ReadonlyMap<string, Value> }

/**
 * One sidebar input main is taking over: what the window derives itself next to what main
 * publishes, keyed by workspace. Both reads cover the same scope; another producer's rows are
 * left out of both.
 */
export type SidebarShadowDomain<Value, Main extends SidebarShadowMainRead<Value>> = {
  name: string
  /** Given main's read, so a domain can scope the window's side to what main covers. */
  readWindow: (main: Main) => ReadonlyMap<string, Value>
  /** Null when this host does not publish the domain (an older host). */
  readMain: () => Promise<Main | null>
  equals: (window: Value | undefined, main: Value | undefined) => boolean
}

export type SidebarShadowMismatch = {
  domain: string
  key: string
  window: unknown
  main: unknown
  mainRevision?: number
}

/** One domain's comparison, with its value type closed over; false when main published nothing. */
export type SidebarShadowCheck = (
  record: (mismatch: SidebarShadowMismatch) => void
) => Promise<boolean>

const CHECK_INTERVAL_MS = 1_500

/**
 * Records settled disagreements only: a key is recorded once both sides held the same differing
 * values across a whole check interval, so propagation lag between window and main never counts.
 */
export function defineSidebarShadowDomain<
  Value,
  Main extends SidebarShadowMainRead<Value> = SidebarShadowMainRead<Value>
>(domain: SidebarShadowDomain<Value, Main>): SidebarShadowCheck {
  let pending = new Map<string, string>()
  const recorded = new Set<string>()
  return async (record) => {
    const main = await domain.readMain()
    if (!main) {
      return false
    }
    const window = domain.readWindow(main)
    const next = new Map<string, string>()
    for (const key of new Set([...window.keys(), ...main.values.keys()])) {
      const windowValue = window.get(key) ?? null
      const mainValue = main.values.get(key) ?? null
      if (domain.equals(window.get(key), main.values.get(key))) {
        continue
      }
      // Values only: main's revision moves with every workspace, which would keep resetting this one.
      const signature = JSON.stringify([key, windowValue, mainValue])
      next.set(key, signature)
      if (pending.get(key) === signature && !recorded.has(signature)) {
        recorded.add(signature)
        record({
          domain: domain.name,
          key,
          window: windowValue,
          main: mainValue,
          mainRevision: main.revision
        })
      }
    }
    pending = next
    return true
  }
}

/** Dev and test builds only; production never runs the comparison. */
export function installSidebarShadowComparison(checks: readonly SidebarShadowCheck[]): () => void {
  if (!(import.meta.env.DEV || e2eConfig.exposeStore) || typeof window === 'undefined') {
    return () => {}
  }
  const mismatches: SidebarShadowMismatch[] = []
  const record = (mismatch: SidebarShadowMismatch): void => {
    mismatches.push(mismatch)
    console.warn('[sidebar-shadow] window and main disagree', mismatch)
  }
  let comparisons = 0
  window.__sidebarShadow = {
    comparisons: () => comparisons,
    mismatches: () => [...mismatches]
  }
  let inFlight = false
  const timer = setInterval(() => {
    if (inFlight) {
      return
    }
    inFlight = true
    void (async () => {
      let everyCompared = true
      for (const check of checks) {
        const compared = await check(record).catch((error: unknown) => {
          console.warn('[sidebar-shadow] check failed', error)
          return false
        })
        everyCompared &&= compared
      }
      // A round counts once every domain compared, so two rounds re-check each domain twice.
      comparisons += everyCompared ? 1 : 0
    })().finally(() => {
      inFlight = false
    })
  }, CHECK_INTERVAL_MS)
  return () => {
    clearInterval(timer)
    delete window.__sidebarShadow
  }
}
