import { describePluginErrorForLog } from './declarative-error-location'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../plugin-declarative-message-names'
import { hostAtom, read, subscribeAtom, trackAtomReads, type OrcaAtom } from './declarative-atoms'
import type { OrcaComponent } from './declarative-elements'
import type {
  OrcaDeclarativeRuntime,
  OrcaDisposable,
  OrcaRuntimeOptions,
  OrcaTheme
} from './declarative-runtime-types'
import { evaluateOrcaTree, type OrcaCallback } from './declarative-evaluate'
import { createMemoryRetention } from './declarative-memory-retention'
import { actSnapshotSubscriptions } from './declarative-act-snapshot'
import {
  defaultSchedule,
  errorMessage,
  HYDRATION_TIMEOUT_MS,
  isCallable,
  MAX_RETAINED_RENDERS,
  MIN_RENDER_INTERVAL_MS,
  newDocumentId
} from './declarative-renderer-support'
import { readHostMessage } from './declarative-host-messages'
import { createPanelContext } from './declarative-panel-context'
import { createDeclarativePersistence } from './declarative-storage-sync'

export type { OrcaWireNode } from './declarative-evaluate'
export type {
  OrcaBridge,
  OrcaColorScheme,
  OrcaDeclarativeRuntime,
  OrcaDisposable,
  OrcaPanelContext,
  OrcaPanelModule,
  OrcaRuntimeOptions,
  OrcaTheme
} from './declarative-runtime-types'

export function createOrcaDeclarativeRuntime(options: OrcaRuntimeOptions): OrcaDeclarativeRuntime {
  const { post } = options
  const bridge = options.bridge ?? null
  const schedule = options.schedule ?? defaultSchedule
  const now = options.now ?? (() => Date.now())
  const document = newDocumentId(now())
  const theme = hostAtom<OrcaTheme>({ colorScheme: options.colorScheme ?? 'dark' })
  const retention = createMemoryRetention((entries) =>
    post(PLUGIN_DECLARATIVE_MESSAGES.retain, { document, entries })
  )
  const panel = createPanelContext(retention.start)
  const { context } = panel
  let component: OrcaComponent | null = null
  let revision = 0
  let lastRenderAt = Number.NEGATIVE_INFINITY
  /** Callback tables by revision: the one on screen (accepted) plus every newer one. */
  let renders = new Map<number, Map<string, OrcaCallback>>()
  let accepted: number | null = null
  const editsSeen = new Map<string, number>()
  let subscriptions = new Map<OrcaAtom<unknown>, () => void>()
  let scheduled = false
  let setupCleanup: (() => void) | null = null
  let disposed = false

  function invalidate(delayMs = 0): void {
    if (scheduled || !component) {
      return
    }
    scheduled = true
    const wait = Math.max(delayMs, lastRenderAt + MIN_RENDER_INTERVAL_MS - now())
    schedule(() => {
      if (scheduled) {
        render()
      }
    }, wait)
  }

  function resubscribe(reads: Set<OrcaAtom<unknown>>): void {
    const next = new Map<OrcaAtom<unknown>, () => void>()
    for (const target of reads) {
      next.set(target, subscriptions.get(target) ?? subscribeAtom(target, () => invalidate()))
    }
    for (const [target, unsubscribe] of subscriptions) {
      if (!next.has(target)) {
        unsubscribe()
      }
    }
    subscriptions = next
  }

  function report(error: unknown): void {
    // Main routes guest console errors to `orca plugin logs`; this text is located like the banner.
    console.error(describePluginErrorForLog(error))
    const stack = error instanceof Error && error.stack ? error.stack.slice(0, 8192) : undefined
    post(PLUGIN_DECLARATIVE_MESSAGES.error, {
      document,
      revision,
      message: errorMessage(error),
      ...(stack ? { stack } : {})
    })
  }

  function retain(at: number, callbacks: Map<string, OrcaCallback>): void {
    renders.set(at, callbacks)
    for (const kept of renders.keys()) {
      if (renders.size <= MAX_RETAINED_RENDERS) {
        break
      }
      if (kept !== accepted) {
        renders.delete(kept)
      }
    }
  }

  function render(): void {
    scheduled = false
    if (!component || disposed) {
      return
    }
    lastRenderAt = now()
    const reads = new Set<OrcaAtom<unknown>>()
    const mounted = component
    let evaluation
    try {
      evaluation = trackAtomReads(reads, () => evaluateOrcaTree(mounted, editsSeen))
    } catch (error) {
      // Nothing is committed. Keep old subscriptions too, so a fix to either state re-renders.
      resubscribe(new Set([...subscriptions.keys(), ...reads]))
      report(error)
      return
    }
    revision += 1
    retain(revision, evaluation.callbacks)
    resubscribe(reads)
    post(PLUGIN_DECLARATIVE_MESSAGES.render, { document, revision, tree: evaluation.tree })
  }

  function dispatchEvent(payload: unknown): boolean {
    const message = readHostMessage(payload)
    const { callback, args, edit } = message
    if (message.document !== document || typeof callback !== 'string') {
      return false
    }
    // Strictly the tree the person saw: a newer, unshown render may bind the same id elsewhere.
    const handler =
      typeof message.revision === 'number'
        ? renders.get(message.revision)?.get(callback)
        : undefined
    if (!handler) {
      return false
    }
    if (typeof edit === 'number' && Number.isSafeInteger(edit)) {
      editsSeen.set(callback, Math.max(edit, editsSeen.get(callback) ?? 0))
      // The next render must report the edit as seen, even if the plugin ignores it.
      invalidate()
    }
    try {
      const result = handler(...(Array.isArray(args) ? args : []))
      if (result instanceof Promise) {
        result.catch(report)
      }
    } catch (error) {
      report(error)
    }
    return true
  }

  function acknowledge(payload: unknown): void {
    const message = readHostMessage(payload)
    const acked = message.revision
    if (message.document !== document || typeof acked !== 'number' || !renders.has(acked)) {
      return
    }
    if (message.accepted === true) {
      // Older tables retire only now: until this tree was shown, theirs was on screen.
      accepted = acked
      for (const kept of renders.keys()) {
        if (kept < acked) {
          renders.delete(kept)
        }
      }
      return
    }
    // A refused render never reached the screen; events keep resolving against the accepted one.
    renders.delete(acked)
    const retryAfterMs = message.retryAfterMs
    if (typeof retryAfterMs === 'number' && acked === revision) {
      invalidate(retryAfterMs)
    }
  }

  const persistence = createDeclarativePersistence({
    bridge,
    report,
    post: (entries) => post(PLUGIN_DECLARATIVE_MESSAGES.persist, { document, entries })
  })
  const flushPersist = persistence.flush

  const bridgeSubscriptions: OrcaDisposable[] = bridge?.on
    ? [
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.event, dispatchEvent),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.ack, acknowledge),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.hydrate, panel.hydrate),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.visibility, panel.setVisibility),
        ...actSnapshotSubscriptions(bridge.on.bind(bridge), document),
        bridge.on('theme', (payload) => {
          const { colorScheme } = readHostMessage(payload)
          if (
            (colorScheme === 'light' || colorScheme === 'dark') &&
            read(theme.atom).colorScheme !== colorScheme
          ) {
            theme.set({ colorScheme })
          }
        })
      ]
    : []

  if (options.awaitHydration) {
    post(PLUGIN_DECLARATIVE_MESSAGES.ready, { document })
    const fallback = setTimeout(panel.markHydrated, HYDRATION_TIMEOUT_MS)
    // Why cleared: a pending timer would keep a test process (Node) alive for seconds.
    void panel.hydrated.then(() => clearTimeout(fallback))
  } else {
    panel.markHydrated()
  }

  function unsubscribeAll(): void {
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe()
    }
    subscriptions = new Map()
  }

  const runtime: OrcaDeclarativeRuntime = {
    document,
    async boot(module) {
      await panel.hydrated
      await persistence.loaded()
      if (isCallable(module.setup)) {
        const cleanup = module.setup(context)
        setupCleanup = isCallable(cleanup) ? () => void cleanup() : null
      }
      const panelComponent = module.default
      if (isCallable(panelComponent)) {
        runtime.mount((props) => panelComponent(props))
      } else if (!component) {
        const kind = module.default === null ? 'null' : typeof module.default
        throw new Error(
          `The panel module must export a component function as its default export (got ${kind})`
        )
      }
    },
    mount(next) {
      component = next
      if (panel.isHydrated()) {
        render()
        return
      }
      void panel.hydrated.then(() => {
        if (component === next) {
          render()
        }
      })
    },
    unmount() {
      component = null
      scheduled = false
      unsubscribeAll()
      renders = new Map()
      accepted = null
      revision += 1
      post(PLUGIN_DECLARATIVE_MESSAGES.render, { document, revision, tree: null })
    },
    mounted: () => component !== null,
    dispatchEvent,
    acknowledge,
    hydrate: panel.hydrate,
    rerender: () => render(),
    flush() {
      if (scheduled) {
        render()
      }
      flushPersist()
      retention.flush()
    },
    report,
    themeAtom: theme.atom,
    bridge,
    dispose() {
      if (disposed) {
        return
      }
      flushPersist()
      retention.stop()
      disposed = true
      component = null
      scheduled = false
      unsubscribeAll()
      persistence.dispose()
      for (const subscription of [...bridgeSubscriptions, ...context.subscriptions]) {
        try {
          subscription.dispose()
        } catch (error) {
          report(error)
        }
      }
      try {
        setupCleanup?.()
      } catch (error) {
        report(error)
      }
      panel.abort()
    }
  }
  return runtime
}
