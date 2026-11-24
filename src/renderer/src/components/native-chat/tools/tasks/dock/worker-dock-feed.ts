import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WorkerDockPresence } from '../../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'
import {
  WorkerDockSnapshot,
  type WorkerDockEntry
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import { currentOnOlderHosts } from './worker-dock-older-host-roster'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../../../shared/agent-session/identity/orca-session-address'

type State = {
  snapshot: WorkerDockSnapshot | null
  available: boolean
  rows: ReadonlyMap<string, WorkerDockEntry>
  /** Counts every publication that lost the feed. It is read live, so a loss and a recovery
   *  published before React renders still show as a change. */
  losses: number
}
const EMPTY: State = { snapshot: null, available: true, rows: new Map(), losses: 0 }

class WorkerDockFeed {
  state = EMPTY
  private listeners = new Set<() => void>()
  private details = new Set<() => void>()
  private detailed = false
  private stop: (() => void) | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private aging: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private active = false
  get unused(): boolean {
    return this.listeners.size === 0
  }
  private loading = new Set<string>()
  constructor(
    readonly target: RuntimeClientTarget,
    readonly party: string
  ) {}
  private publish(snapshot: WorkerDockSnapshot | null, available: boolean): void {
    if (snapshot && this.state.snapshot && snapshot.revision < this.state.snapshot.revision) {
      return
    }
    // Hosts predating currentOnly still include settled entries in the same snapshot.
    if (snapshot && !snapshot.currentOnly) {
      const now = Date.now()
      const { kept, nextExpiry } = currentOnOlderHosts(snapshot.identities, now)
      if (kept.size !== snapshot.identities.length) {
        snapshot = {
          ...snapshot,
          identities: snapshot.identities.filter((row) => kept.has(row.id)),
          rows: snapshot.rows.filter((row) => kept.has(row.id))
        }
      }
      // An older host sends nothing when a row ages out, so the feed wakes itself for the next one.
      clearTimeout(this.aging)
      this.aging =
        nextExpiry === undefined
          ? undefined
          : setTimeout(() => {
              if (this.listeners.size && this.state.snapshot) {
                this.publish(this.state.snapshot, this.state.available)
              }
            }, nextExpiry - now)
    } else if (snapshot) {
      clearTimeout(this.aging)
    }
    const rows = new Map(this.state.rows)
    for (const row of snapshot?.rows ?? []) {
      const previous = rows.get(row.id)
      rows.set(
        row.id,
        previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row
      )
    }
    // Keep only the neighboring detail window; identities and counts remain metadata-only.
    if (rows.size > 100 && snapshot) {
      const keep = new Set(snapshot.rows.map((row) => row.id))
      for (const key of rows.keys()) {
        if (rows.size <= 100) {
          break
        }
        if (!keep.has(key)) {
          rows.delete(key)
        }
      }
    }
    this.state = {
      snapshot: snapshot ?? this.state.snapshot,
      available,
      rows,
      losses: this.state.losses + (available ? 0 : 1)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
  private open(): void {
    if (!this.listeners.size || this.active) {
      return
    }
    clearTimeout(this.retry)
    this.retry = undefined
    this.active = true
    const generation = ++this.generation
    const live = () => generation === this.generation && this.listeners.size > 0
    const lose = (error?: unknown) => {
      if (!live()) {
        return
      }
      ++this.generation
      this.active = false
      this.stop?.()
      this.stop = undefined
      this.publish(null, false)
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code !== 'method_not_found' && code !== 'forbidden' && code !== 'unsupported_method') {
        this.retry = setTimeout(() => this.open(), 5000)
      }
    }
    void subscribeRuntimeRpc(
      this.target,
      'orchestration.workerDockSubscribe',
      { party: this.party, includeRows: this.detailed, currentOnly: true },
      {
        onEvent: (value) => {
          if (!live()) {
            return
          }
          const parsed = WorkerDockSnapshot.safeParse(value)
          if (parsed.success) {
            this.publish(parsed.data, !parsed.data.unavailable)
          } else {
            lose({ code: 'invalid_runtime_response' })
          }
        },
        onError: lose,
        onClose: lose
      }
    ).then((handle) => {
      if (live()) {
        this.stop = handle.unsubscribe
      } else {
        handle.unsubscribe()
      }
    }, lose)
  }
  private reconcile(): void {
    const detailed = this.details.size > 0
    if (detailed !== this.detailed) {
      ++this.generation
      this.active = false
      this.stop?.()
      this.stop = undefined
      this.detailed = detailed
    }
    this.open()
  }
  subscribe = (listener: () => void, detailed: boolean): (() => void) => {
    this.listeners.add(listener)
    if (detailed) {
      this.details.add(listener)
    }
    this.reconcile()
    return () => {
      this.listeners.delete(listener)
      this.details.delete(listener)
      queueMicrotask(() => {
        if (!this.listeners.size) {
          ++this.generation
          this.active = false
          clearTimeout(this.retry)
          clearTimeout(this.aging)
          this.stop?.()
          this.stop = undefined
        } else {
          this.reconcile()
        }
      })
    }
  }
  read = (): State => this.state
  window = async (anchor: string): Promise<void> => {
    if (!this.listeners.size || this.loading.has(anchor)) {
      return
    }
    this.loading.add(anchor)
    const generation = this.generation
    const revision = this.state.snapshot?.revision
    try {
      const result = await callRuntimeRpc(this.target, 'orchestration.workerDockRead', {
        party: this.party,
        revision,
        anchor,
        currentOnly: true
      })
      if (generation === this.generation && this.listeners.size) {
        this.publish(WorkerDockSnapshot.parse(result), true)
      }
    } catch {
      if (generation === this.generation && this.state.snapshot?.revision === revision) {
        this.publish(null, false)
      }
    } finally {
      this.loading.delete(anchor)
    }
  }
}
const feeds = new Map<string, WorkerDockFeed>()
const noopSubscribe = () => () => {}
export function useWorkerDockFeed(
  target: RuntimeClientTarget,
  sessionId: string,
  visible: boolean,
  presence?: WorkerDockPresence,
  detailed = true
) {
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  const key = `${target.kind === 'local' ? 'local' : target.environmentId}\0${sessionId}\0${presence?.revision.split(':')[0] ?? ''}`
  let feed = feeds.get(key)
  if (!feed && presence && isOrcaSessionId(sessionId)) {
    feed = new WorkerDockFeed(target, formatOrcaSessionAddress(sessionId))
    feeds.set(key, feed)
    if (feeds.size > 32) {
      for (const [cachedKey, cached] of feeds) {
        if (feeds.size <= 32) {
          break
        }
        if (cachedKey !== key && cached.unused) {
          feeds.delete(cachedKey)
        }
      }
    }
  }
  const subscribe = useCallback(
    (listener: () => void) =>
      visible && windowVisible && presence && feed
        ? feed.subscribe(listener, detailed)
        : noopSubscribe(),
    [feed, visible, windowVisible, presence, detailed]
  )
  const read = useCallback(() => feed?.read() ?? EMPTY, [feed])
  const value = useSyncExternalStore(subscribe, read)
  // The live loss count, not the rendered one: a press compares it from start to activation.
  const readLosses = useCallback(() => feed?.read().losses ?? 0, [feed])
  return { ...value, party: feed?.party ?? null, loadWindow: feed?.window, readLosses }
}

const seededSources = new Set<string>()
const seedingSources = new Set<string>()
/** One visible cold read per source that succeeded; a failed one runs again when the window or pane
 *  shows again. Steady empty sources allocate no feed or watcher. */
export function useWorkerDockColdSeed(
  target: RuntimeClientTarget,
  sessionId: string,
  visible: boolean,
  presence?: WorkerDockPresence
) {
  const key = `${target.kind === 'local' ? 'local' : target.environmentId}\0${sessionId}`
  useEffect(() => {
    if (!visible || presence || !isOrcaSessionId(sessionId) || seededSources.has(key)) {
      return
    }
    let stop: (() => void) | undefined
    const unsubscribe = () => {
      stop?.()
      stop = undefined
    }
    const seed = () => {
      if (!getWindowParkVisible() || seededSources.has(key) || seedingSources.has(key)) {
        return
      }
      seedingSources.add(key)
      void callRuntimeRpc(target, 'orchestration.workerDockRead', {
        party: formatOrcaSessionAddress(sessionId),
        seed: true,
        includeRows: false,
        currentOnly: true
      })
        .then(() => {
          seededSources.add(key)
          unsubscribe()
        })
        .catch(() => {})
        .finally(() => seedingSources.delete(key))
    }
    stop = subscribeWindowParkVisibility(seed)
    seed()
    return unsubscribe
  }, [target, sessionId, visible, presence, key])
}
