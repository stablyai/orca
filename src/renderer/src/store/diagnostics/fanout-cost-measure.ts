// Measurement only (never shipped): per-write notify time and per-reader cost on the app store.
type Row = { calls: number; ms: number; changed: number; sample?: Error }
type Fanout = {
  writes: { ms: number; listeners: number; keys: string }[]
  readers: Map<string, Row>
  raw: Map<string, Row>
  inNotify: boolean
}
const g = globalThis as unknown as { __orcaFanout?: Fanout }
const f: Fanout = (g.__orcaFanout = { writes: [], readers: new Map(), raw: new Map(), inNotify: false })

function bump(map: Map<string, Row>, key: string, ms: number, changed: boolean, sample?: () => Error) {
  let row = map.get(key)
  if (!row) {
    row = { calls: 0, ms: 0, changed: 0, sample: sample?.() }
    map.set(key, row)
  }
  row.calls += 1
  row.ms += ms
  if (changed) row.changed += 1
}

type Api = {
  setState: (...args: never[]) => void
  getState: () => Record<string, unknown>
  subscribe: (l: (s: unknown, p: unknown) => void) => () => void
}
let listeners = 0
export function installFanoutCostMeasure(apiIn: unknown, setIn: unknown): unknown {
  const api = apiIn as Api
  const timed = (setState: Api['setState']) =>
    ((...args: never[]) => {
      const before = api.getState()
      const outer = !f.inNotify
      f.inNotify = true
      const t0 = performance.now()
      try {
        setState(...args)
      } finally {
        if (outer) {
          f.inNotify = false
          const after = api.getState()
          if (after !== before && f.writes.length < 100_000) {
            const keys: string[] = []
            for (const k in after) if (!Object.is(after[k], before[k])) keys.push(k)
            f.writes.push({ ms: performance.now() - t0, listeners, keys: keys.sort().join(',') })
          }
        }
      }
    }) as Api['setState']
  api.setState = timed(api.setState)
  const subscribe = api.subscribe
  api.subscribe = (listener) => {
    const site = new Error()
    let key: string | null = null
    const wrapped = (s: unknown, p: unknown): void => {
      const t0 = performance.now()
      listener(s, p)
      key ??= rawKey(listener, site)
      if (key) bump(f.raw, key, performance.now() - t0, false, () => site)
    }
    listeners += 1
    const off = subscribe(wrapped)
    let done = false
    return () => {
      if (!done) {
        done = true
        listeners -= 1
      }
      off()
    }
  }
  return timed(setIn as Api['setState'])
}

// React subscribers (useSyncExternalStore's handleStoreChange) are measured per selector instead.
function rawKey(listener: unknown, site: Error): string {
  const text = String(listener)
  if (text.includes('checkIfSnapshotChanged') || text.includes('forceStoreRerender')) return ''
  return frames(site, 4)
}

function frames(e: Error, n: number): string {
  return (e.stack ?? '')
    .split('\n')
    .slice(1)
    .filter((l) => !/fanout-cost-measure|measureSelector|useAppStoreMeasured|node_modules|zustand|Error$/.test(l))
    .slice(0, n)
    .map((l) => l.trim().replace(/\(?https?:\/\/[^)]*\/|\(?file:\/\/[^)]*\//g, '').replace(/\)$/, ''))
    .join(' < ')
}

export function measureSelector<T, R>(selector: (s: T) => R): (s: T) => R {
  const cached = stable.get(selector)
  if (cached) return cached as (s: T) => R
  const text = String(selector)
  const site = new Error()
  let key: string | null = null
  let last: R | typeof UNSET = UNSET
  const wrapper = (s: T): R => {
    if (!f.inNotify) {
      const r = selector(s)
      last = r
      return r
    }
    const t0 = performance.now()
    const r = selector(s)
    const ms = performance.now() - t0
    key ??= `${text.replace(/\s+/g, ' ').slice(0, 60)} @ ${frames(site, 3)}`
    bump(f.readers, key, ms, last !== UNSET && !Object.is(last, r), () => site)
    last = r
    return r
  }
  stable.set(selector, wrapper)
  return wrapper
}
const stable = new WeakMap<object, unknown>()
const UNSET = Symbol('unset')
