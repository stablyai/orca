import { PLUGIN_DECLARATIVE_MESSAGES } from '../plugin-declarative-message-names'
import {
  hostAtom,
  read,
  subscribeAtom,
  trackAtomReads,
  watchPersistedAtoms,
  type OrcaAtom
} from './declarative-atoms'
import type { OrcaComponent } from './declarative-elements'
import type {
  OrcaDeclarativeRuntime,
  OrcaDisposable,
  OrcaRuntimeOptions,
  OrcaTheme
} from './declarative-runtime-types'
import { evaluateOrcaTree, type OrcaCallback } from './declarative-evaluate'
import { createPersistQueue } from './declarative-persist-queue'
import { readHostMessage } from './declarative-host-messages'
import { createPanelContext } from './declarative-panel-context'

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

// Why: an update loop must not flood the host; ~one render per display frame is plenty.
const MIN_RENDER_INTERVAL_MS = 16
// Renders the host has not acknowledged yet whose callbacks stay resolvable.
const MAX_RETAINED_RENDERS = 32
// Why a ceiling: an older host never answers `ui.ready`, and the panel must still appear.
const HYDRATION_TIMEOUT_MS = 3000

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4096)
}

function defaultSchedule(flush: () => void, delayMs: number): void {
  if (delayMs > 0) {
    setTimeout(flush, delayMs)
  } else {
    queueMicrotask(flush)
  }
}

function newDocumentId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

export function createOrcaDeclarativeRuntime(options: OrcaRuntimeOptions): OrcaDeclarativeRuntime {
  const { post } = options
  const bridge = options.bridge ?? null
  const schedule = options.schedule ?? defaultSchedule
  const now = options.now ?? (() => Date.now())
  const document = newDocumentId(now())
  const theme = hostAtom<OrcaTheme>({ colorScheme: options.colorScheme ?? 'dark' })
  const panel = createPanelContext()
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
    post(PLUGIN_DECLARATIVE_MESSAGES.error, { document, revision, message: errorMessage(error) })
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

  const persistQueue = createPersistQueue({
    report,
    post: (entries) => post(PLUGIN_DECLARATIVE_MESSAGES.persist, { document, entries })
  })
  const flushPersist = persistQueue.flush
  watchPersistedAtoms(persistQueue.add)

  const bridgeSubscriptions: OrcaDisposable[] = bridge?.on
    ? [
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.event, dispatchEvent),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.ack, acknowledge),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.hydrate, panel.hydrate),
        bridge.on(PLUGIN_DECLARATIVE_MESSAGES.visibility, panel.setVisibility),
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
    setTimeout(panel.markHydrated, HYDRATION_TIMEOUT_MS)
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
    flush() {
      if (scheduled) {
        render()
      }
      flushPersist()
    },
    themeAtom: theme.atom,
    bridge,
    dispose() {
      if (disposed) {
        return
      }
      flushPersist()
      disposed = true
      component = null
      scheduled = false
      unsubscribeAll()
      watchPersistedAtoms(null)
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
