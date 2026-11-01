import { PLUGIN_DECLARATIVE_MESSAGES } from '../plugin-declarative-message-names'
import {
  parsePluginDeclarativeRender,
  pluginDeclarativeErrorPayloadSchema,
  pluginDeclarativePersistPayloadSchema
} from '../plugin-declarative-messages'
import type { PluginDeclarativeNode } from '../plugin-declarative-catalog'
import { installOrcaDeclarativeRuntime } from '../runtime/orca-module'
import type { OrcaDeclarativeRuntime, OrcaPanelModule } from '../runtime/declarative-runtime-types'
import type { MockHost } from './testing-host'
import {
  describeQuery,
  innermost,
  listElements,
  matchesQuery,
  snapshotTree,
  type TestElement,
  type TestQuery,
  type TreeSnapshot
} from './testing-tree'
import { createValueControls } from './testing-value-controls'
import { createTestingPanelFacades } from './testing-panel-facades'
import { seedPersisted } from './testing-persisted'

export { stored, type StoredValue } from './testing-persisted'

export type PanelIssue = { kind: 'plugin' | 'refused'; message: string; stack?: string }
type Stored = { version: number; value: unknown }
export type PersistedState = {
  plugin: Record<string, unknown>
  workspace: Record<string, unknown>
  /** The plugin's storage (`persist: 'storage'` atoms and `storage.set`), on the mock host. */
  storage: Record<string, unknown>
}

export type MountOptions = {
  host: MockHost
  theme?: 'light' | 'dark'
  locale?: string
  visible?: boolean
  panelId?: string
  /** Values persisted by an earlier run: plain values are stored at version 1; see `stored()`. */
  persisted?: { plugin?: Record<string, unknown>; workspace?: Record<string, unknown> }
}

type Target = TestElement | TestQuery

function isElement(target: Target): target is TestElement {
  return 'path' in target
}
// Why a cap: an update loop would otherwise spin a test forever instead of failing it.
const MAX_SETTLE_ROUNDS = 100

const nextTask = (): Promise<void> =>
  new Promise((resolve) =>
    typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)
  )

export async function mountPanel(
  target:
    | OrcaPanelModule
    | ((props: Record<string, unknown>) => unknown)
    | Promise<OrcaPanelModule>,
  options: MountOptions
) {
  const host = options.host
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (event: string, payload: unknown): void => {
    for (const handler of listeners.get(event) ?? []) {
      handler(payload)
    }
  }
  const queue: (() => void)[] = []
  const errors: PanelIssue[] = []
  const warnings: string[] = []
  const storage: Record<'plugin' | 'workspace', Map<string, Stored>> = {
    plugin: new Map(),
    workspace: new Map()
  }
  seedPersisted(storage, options.persisted)
  let visible = options.visible ?? true
  let shown: { document: string; revision: number; tree: PluginDeclarativeNode | null } = {
    document: '',
    revision: 0,
    tree: null
  }
  const controls = createValueControls()
  const data = createTestingPanelFacades(host.bridge.call)
  const stopDataChanges = host.onDataChange(data.changed)

  function post(event: string, payload: unknown): void {
    if (event === PLUGIN_DECLARATIVE_MESSAGES.ready) {
      emit(PLUGIN_DECLARATIVE_MESSAGES.hydrate, {
        panel: { id: options.panelId ?? 'panel' },
        visible,
        plugin: Object.fromEntries(storage.plugin),
        workspace: Object.fromEntries(storage.workspace)
      })
    } else if (event === PLUGIN_DECLARATIVE_MESSAGES.render) {
      const parsed = parsePluginDeclarativeRender(payload)
      if (!parsed.ok) {
        // Exactly what Orca refuses: the panel would keep showing its last good tree.
        errors.push({ kind: 'refused', message: parsed.error })
        if (parsed.document !== null && parsed.revision !== null) {
          emit(PLUGIN_DECLARATIVE_MESSAGES.ack, {
            document: parsed.document,
            revision: parsed.revision,
            accepted: false
          })
        }
        return
      }
      warnings.push(...parsed.warnings.filter((warning) => !warnings.includes(warning)))
      shown = { document: parsed.document, revision: parsed.revision, tree: parsed.tree }
      controls.observe(listElements(parsed.tree))
      emit(PLUGIN_DECLARATIVE_MESSAGES.ack, {
        document: parsed.document,
        revision: parsed.revision,
        accepted: true
      })
    } else if (event === PLUGIN_DECLARATIVE_MESSAGES.error) {
      const parsed = pluginDeclarativeErrorPayloadSchema.safeParse(payload)
      errors.push(
        parsed.success
          ? {
              kind: 'plugin',
              message: parsed.data.message,
              ...(parsed.data.stack ? { stack: parsed.data.stack } : {})
            }
          : { kind: 'plugin', message: String(payload) }
      )
    } else if (event === PLUGIN_DECLARATIVE_MESSAGES.persist) {
      const parsed = pluginDeclarativePersistPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        errors.push({ kind: 'refused', message: 'persisted state Orca would not store' })
        return
      }
      for (const entry of parsed.data.entries) {
        storage[entry.scope].set(entry.key, { version: entry.version, value: entry.value })
      }
    }
  }

  const runtime: OrcaDeclarativeRuntime = installOrcaDeclarativeRuntime({
    post,
    awaitHydration: true,
    colorScheme: options.theme ?? 'dark',
    schedule: (flush) => queue.push(flush),
    bridge: {
      api: host.bridge.api,
      locale: options.locale ?? 'en',
      host: { call: host.bridge.call, has: host.bridge.has },
      ...data.facades,
      on(event, handler) {
        const set = listeners.get(event) ?? new Set()
        set.add(handler)
        listeners.set(event, set)
        return { dispose: () => set.delete(handler) }
      }
    }
  })

  async function settled(): Promise<void> {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      await nextTask()
      const flushes = queue.splice(0)
      for (const flush of flushes) {
        flush()
      }
      const busy = host.calls.length
      await host.idle()
      if (flushes.length === 0 && busy === host.calls.length) {
        runtime.flush()
        return
      }
    }
    throw new Error('the panel did not settle: it keeps re-rendering (an update loop?)')
  }

  const findAll = (query: TestQuery): TestElement[] =>
    innermost(listElements(shown.tree).filter((element) => matchesQuery(element, query)))

  function resolve(target: Target, verb: string): TestElement {
    const found = isElement(target)
      ? listElements(shown.tree).find((element) => element.path === target.path)
      : findAll(target)[0]
    if (!found) {
      throw new Error(
        isElement(target)
          ? `${verb}: the element is no longer in the panel`
          : `${verb}: nothing in the panel matches { ${describeQuery(target)} }`
      )
    }
    if (found.disabled) {
      throw new Error(`${verb}: the ${found.type} is disabled`)
    }
    return found
  }

  function dispatch(callback: unknown, args: unknown[], edit?: number): void {
    const id =
      typeof callback === 'object' && callback !== null && '$callback' in callback
        ? callback.$callback
        : null
    if (typeof id !== 'string') {
      return
    }
    emit(PLUGIN_DECLARATIVE_MESSAGES.event, {
      document: shown.document,
      revision: shown.revision,
      callback: id,
      args,
      ...(edit === undefined ? {} : { edit })
    })
  }

  await Promise.resolve(typeof target === 'function' ? { default: target } : target)
    .then((module) => runtime.boot(module))
    .catch((error: unknown) =>
      errors.push({
        kind: 'plugin',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
      })
    )
  await settled()

  return {
    host,
    /** Plugin errors (a throw in render or a handler) and renders Orca would refuse. */
    errors,
    /** Props and components Orca would drop, as it would warn about them. */
    warnings,
    find: (query: TestQuery): TestElement | null => findAll(query)[0] ?? null,
    findAll,
    tree: (): TreeSnapshot | string | null => (shown.tree ? snapshotTree(shown.tree) : null),
    get persisted(): PersistedState {
      const read = (scope: 'plugin' | 'workspace') =>
        Object.fromEntries([...storage[scope]].map(([key, entry]) => [key, entry.value]))
      return { plugin: read('plugin'), workspace: read('workspace'), storage: host.data().storage }
    },
    settled,
    async press(target: Target): Promise<void> {
      const element = resolve(target, 'press')
      const { href, onPress } = element.props
      if (element.type === 'Link' && typeof href === 'string') {
        // Orca opens a Link's href itself, spending the press; onPress then runs without one.
        host.grantGesture()
        void host.bridge.call('shell.openExternal', { url: href }).catch(() => undefined)
      } else if (onPress === undefined) {
        throw new Error(`press: the ${element.type} has no onPress`)
      } else {
        host.grantGesture()
      }
      dispatch(onPress, [])
      await settled()
    },
    async type(target: Target, text: string, typing: { replace?: boolean; submit?: boolean } = {}) {
      const element = resolve(target, 'type')
      for (const edit of controls.typeInto(element, text, typing.replace === true)) {
        dispatch(element.props.onChange, [edit.value], edit.id)
        await settled()
      }
      if (typing.submit) {
        dispatch(element.props.onSubmit, [controls.valueOf(element)])
        await settled()
      }
    },
    async submit(target: Target): Promise<void> {
      const element = resolve(target, 'submit')
      dispatch(element.props.onSubmit, [controls.valueOf(element)])
      await settled()
    },
    async toggle(target: Target): Promise<void> {
      const element = resolve(target, 'toggle')
      const edit = controls.toggle(element)
      dispatch(element.props.onChange, [edit.value], edit.id)
      await settled()
    },
    async select(target: Target, value: string): Promise<void> {
      const element = resolve(target, 'select')
      const edit = controls.select(element, value)
      dispatch(element.props.onChange, [edit.value], edit.id)
      await settled()
    },
    /** What Orca shows in a value control (what the person typed, until the panel resets it). */
    valueOf: (target: Target): unknown => controls.valueOf(resolve(target, 'valueOf')),
    async emit(event: string, payload: unknown): Promise<void> {
      emit(event, payload)
      await settled()
    },
    /** What the plugin's worker posts with `orca.panels.post`; `plugin.on` handlers hear it. */
    async post(event: string, payload: unknown): Promise<void> {
      data.post(event, payload)
      await settled()
    },
    async setVisible(next: boolean): Promise<void> {
      visible = next
      emit(PLUGIN_DECLARATIVE_MESSAGES.visibility, { visible: next })
      await settled()
    },
    async rerender(): Promise<void> {
      runtime.rerender()
      await settled()
    },
    async unmount(): Promise<void> {
      runtime.dispose()
      listeners.clear()
      stopDataChanges()
    }
  }
}

export type TestPanel = Awaited<ReturnType<typeof mountPanel>>
