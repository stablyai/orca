import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { DebugGet, DebugSet } from './debug-session-lifecycle'
import { savePersistedBreakpoints } from './debug-session-paths'
import type {
  DebugAdapterId,
  DebugAdapterStatus,
  DebugBreakpointState,
  DebugFunctionBreakpoint,
  DebugLaunchConfig,
  DebugMissingAdapterOffer
} from './debug-session-types'

const FUNCTION_BREAKPOINTS_STORAGE_KEY = 'orca.debug.functionBreakpoints.v1'

export function loadPersistedFunctionBreakpoints(): DebugFunctionBreakpoint[] {
  try {
    const raw = window.localStorage.getItem(FUNCTION_BREAKPOINTS_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is DebugFunctionBreakpoint =>
        typeof item === 'object' &&
        item !== null &&
        'name' in item &&
        typeof item.name === 'string' &&
        'enabled' in item &&
        typeof item.enabled === 'boolean'
    )
  } catch {
    return []
  }
}

export function savePersistedFunctionBreakpoints(list: readonly DebugFunctionBreakpoint[]): void {
  try {
    window.localStorage.setItem(FUNCTION_BREAKPOINTS_STORAGE_KEY, JSON.stringify(list))
  } catch {
    // Ignore storage unavailability in test environments.
  }
}

export function isMissingAdapterError(adapter: DebugAdapterId, message: string): boolean {
  if (message.startsWith(`debug adapter \`${adapter}\` not found`)) {
    return true
  }
  return adapter === 'debugpy' && message.includes('debugpy is not installed')
}

export type DebugManagementState = {
  functionBreakpoints: DebugFunctionBreakpoint[]
  adapterStatuses: DebugAdapterStatus[]
  installingAdapterId: DebugAdapterId | null
  missingAdapterOffer: DebugMissingAdapterOffer | null
  addFunctionBreakpoint: (name: string) => Promise<void>
  updateFunctionBreakpoint: (
    index: number,
    patch: Partial<DebugFunctionBreakpoint>
  ) => Promise<void>
  removeFunctionBreakpoint: (index: number) => Promise<void>
  removeAllBreakpoints: () => Promise<void>
  refreshAdapterStatuses: (cwd?: string | null) => Promise<void>
  installAdapter: (
    adapter: DebugAdapterId,
    retryConfig?: DebugLaunchConfig | null
  ) => Promise<boolean>
  dismissMissingAdapterOffer: () => void
}

export async function pushFunctionBreakpoints(
  list: DebugFunctionBreakpoint[],
  set: DebugSet,
  muted = false
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  const payload = muted ? list.map((bp) => ({ ...bp, enabled: false })) : list
  try {
    await invokeNative<DebugBreakpointState[]>('poc_debug_set_function_breakpoints', {
      breakpoints: payload
    })
  } catch (err) {
    set({ lastError: err instanceof Error ? err.message : String(err) })
  }
}

export async function syncStoredBreakpointsAndFilters(
  get: DebugGet,
  set: DebugSet,
  pushFileBps: (
    filePath: string,
    next: ReturnType<DebugGet>['breakpointsByFile'][string],
    setFn: DebugSet,
    muted?: boolean
  ) => Promise<void>
): Promise<void> {
  const {
    breakpointPathsByKey,
    breakpointsByFile,
    breakpointsMuted,
    functionBreakpoints,
    exceptionFilterChoices
  } = get()
  for (const [key, bps] of Object.entries(breakpointsByFile)) {
    const bpPath = breakpointPathsByKey[key]
    if (bpPath && bps.length > 0) {
      await pushFileBps(bpPath, bps, set, breakpointsMuted)
    }
  }
  if (functionBreakpoints.length > 0) {
    await pushFunctionBreakpoints(functionBreakpoints, set, breakpointsMuted)
  }
  if (Object.keys(exceptionFilterChoices).length > 0) {
    await invokeNative('poc_debug_set_exception_breakpoints', {
      choices: exceptionFilterChoices
    }).catch(() => {})
  }
}

export function createDebugManagementActions(
  set: DebugSet,
  get: DebugGet
): Pick<
  DebugManagementState,
  | 'addFunctionBreakpoint'
  | 'updateFunctionBreakpoint'
  | 'removeFunctionBreakpoint'
  | 'removeAllBreakpoints'
  | 'refreshAdapterStatuses'
  | 'installAdapter'
  | 'dismissMissingAdapterOffer'
> {
  const applyFunctionBreakpoints = async (next: DebugFunctionBreakpoint[]): Promise<void> => {
    savePersistedFunctionBreakpoints(next)
    set({ functionBreakpoints: next })
    await pushFunctionBreakpoints(next, set, get().breakpointsMuted)
  }

  return {
    addFunctionBreakpoint: async (name) => {
      const trimmed = name.trim()
      if (!trimmed || get().functionBreakpoints.some((bp) => bp.name === trimmed)) {
        return
      }
      await applyFunctionBreakpoints([
        ...get().functionBreakpoints,
        { name: trimmed, enabled: true }
      ])
    },

    updateFunctionBreakpoint: async (index, patch) => {
      const next = get().functionBreakpoints.map((bp, i) =>
        i === index ? { ...bp, ...patch } : bp
      )
      await applyFunctionBreakpoints(next)
    },

    removeFunctionBreakpoint: async (index) => {
      const next = get().functionBreakpoints.filter((_, i) => i !== index)
      await applyFunctionBreakpoints(next)
    },

    removeAllBreakpoints: async () => {
      const paths = Object.values(get().breakpointPathsByKey)
      savePersistedBreakpoints({}, {})
      savePersistedFunctionBreakpoints([])
      set({
        breakpointsByFile: {},
        breakpointPathsByKey: {},
        breakpointStatesByFile: {},
        functionBreakpoints: []
      })
      if (!isTauriNativeHost()) {
        return
      }
      for (const bpPath of paths) {
        await invokeNative('poc_debug_set_breakpoints', { path: bpPath, breakpoints: [] }).catch(
          () => {}
        )
      }
      await invokeNative('poc_debug_set_function_breakpoints', { breakpoints: [] }).catch(() => {})
    },

    refreshAdapterStatuses: async (cwd) => {
      if (!isTauriNativeHost()) {
        return
      }
      try {
        const adapterStatuses = await invokeNative<DebugAdapterStatus[]>(
          'poc_debug_adapter_statuses',
          { cwd: cwd ?? null }
        )
        set({ adapterStatuses })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    installAdapter: async (adapter, retryConfig = null) => {
      if (!isTauriNativeHost()) {
        return false
      }
      set({ installingAdapterId: adapter, lastError: null })
      try {
        const updated = await invokeNative<DebugAdapterStatus>('poc_debug_install_adapter', {
          adapter
        })
        set((s) => ({
          installingAdapterId: null,
          missingAdapterOffer: null,
          adapterStatuses: s.adapterStatuses.some((item) => item.id === updated.id)
            ? s.adapterStatuses.map((item) => (item.id === updated.id ? updated : item))
            : [...s.adapterStatuses, updated]
        }))
        if (retryConfig) {
          await get().startSession(retryConfig)
        }
        return true
      } catch (err) {
        set({
          installingAdapterId: null,
          lastError: err instanceof Error ? err.message : String(err)
        })
        return false
      }
    },

    dismissMissingAdapterOffer: () => set({ missingAdapterOffer: null })
  }
}
