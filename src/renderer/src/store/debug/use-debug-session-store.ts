import { create } from 'zustand'
import { isTauriNativeHost, invokeNative } from '@/web/tauri-native-host'
import { installDebugEventListener } from './debug-event-bridge'
import { createDebugEvaluationActions } from './debug-session-evaluation'
import { createDebugExecutionActions } from './debug-session-execution'
import {
  createDebugSessionEventHandlers,
  pushFileBreakpoints,
  type DebugGet,
  type DebugSessionState,
  type DebugSet
} from './debug-session-lifecycle'
import {
  createDebugManagementActions,
  isMissingAdapterError,
  loadPersistedFunctionBreakpoints,
  syncStoredBreakpointsAndFilters
} from './debug-session-management'
import {
  inferAdapterForFile,
  loadPersistedBreakpoints,
  loadPersistedWatches,
  navigateToSourceLocation,
  normalizeDebugPathKey,
  resolveWorkspaceRoot,
  resolveWorkspaceRootForFile,
  savePersistedBreakpoints
} from './debug-session-paths'
import {
  createConsoleEntry,
  type DebugAdapterId,
  type DebugAdapterStatus,
  type DebugBreakpoint,
  type DebugBreakpointState,
  type DebugCapabilities,
  type DebugDiscoveredLaunchConfig,
  type DebugEvalContext,
  type DebugFunctionBreakpoint,
  type DebugInlineStepRange,
  type DebugLaunchConfig,
  type DebugMissingAdapterOffer,
  type DebugScope,
  type DebugSessionExceptionFilters,
  type DebugSessionInfo,
  type DebugSessionStatus,
  type DebugSmartStepState,
  type DebugStackFrame,
  type DebugThreadInfo,
  type DebugVariable,
  type DebugWatchEntry
} from './debug-session-types'

export {
  inferAdapterForFile,
  navigateToSourceLocation,
  normalizeDebugPathKey,
  resolveWorkspaceRoot,
  resolveWorkspaceRootForFile,
  type DebugAdapterId,
  type DebugAdapterStatus,
  type DebugBreakpoint,
  type DebugBreakpointState,
  type DebugCapabilities,
  type DebugDiscoveredLaunchConfig,
  type DebugEvalContext,
  type DebugFunctionBreakpoint,
  type DebugInlineStepRange,
  type DebugLaunchConfig,
  type DebugMissingAdapterOffer,
  type DebugScope,
  type DebugSessionExceptionFilters,
  type DebugSessionInfo,
  type DebugSessionStatus,
  type DebugSmartStepState,
  type DebugStackFrame,
  type DebugThreadInfo,
  type DebugVariable,
  type DebugWatchEntry
}

const persistedBreakpoints = loadPersistedBreakpoints()
const persistedWatches = loadPersistedWatches()
const persistedFunctionBreakpoints = loadPersistedFunctionBreakpoints()

function persistFileBreakpoints(
  filePath: string,
  next: DebugBreakpoint[],
  get: DebugGet,
  set: DebugSet
): string {
  const key = normalizeDebugPathKey(filePath)
  const nextByFile = { ...get().breakpointsByFile, [key]: next }
  const nextPaths = { ...get().breakpointPathsByKey, [key]: filePath }
  if (next.length === 0) {
    delete nextByFile[key]
    delete nextPaths[key]
  }
  savePersistedBreakpoints(nextByFile, nextPaths)
  set({ breakpointsByFile: nextByFile, breakpointPathsByKey: nextPaths })
  return filePath
}

export const useDebugSessionStore = create<DebugSessionState>((set, get) => ({
  breakpointsByFile: persistedBreakpoints.byKey,
  breakpointPathsByKey: persistedBreakpoints.pathsByKey,
  breakpointStatesByFile: {},
  breakpointsMuted: false,
  functionBreakpoints: persistedFunctionBreakpoints,
  adapterStatuses: [],
  installingAdapterId: null,
  missingAdapterOffer: null,
  sessionsById: {},
  activeSessionId: null,
  sessionId: null,
  status: 'idle',
  threads: [],
  activeThreadId: null,
  activeFrameId: null,
  frames: [],
  scopes: [],
  variablesByRef: {},
  capabilities: null,
  exceptionFilters: [],
  exceptionFilterChoices: {},
  watches: persistedWatches,
  discoveredConfigs: [],
  supportsProgramInput: false,
  stoppedLocation: null,
  smartStep: null,
  consoleLines: [],
  lastError: null,
  panelOpen: false,

  setPanelOpen: (open) => set({ panelOpen: open }),
  clearConsole: () => set({ consoleLines: [], lastError: null }),

  setBreakpointsMuted: async (muted) => {
    set({ breakpointsMuted: muted })
    await syncStoredBreakpointsAndFilters(get, set, pushFileBreakpoints)
  },

  toggleBreakpoint: async (filePath, line1Based) => {
    const key = normalizeDebugPathKey(filePath)
    const current = get().breakpointsByFile[key] ?? []
    const exists = current.some((b) => b.line === line1Based)
    const next = exists
      ? current.filter((b) => b.line !== line1Based)
      : [...current, { line: line1Based, enabled: true }].sort((a, b) => a.line - b.line)

    persistFileBreakpoints(filePath, next, get, set)
    await pushFileBreakpoints(filePath, next, set, get().breakpointsMuted)
  },

  updateBreakpoint: async (filePath, line1Based, patch) => {
    const key = normalizeDebugPathKey(filePath)
    const current = get().breakpointsByFile[key] ?? []
    const next = current.map((bp) => (bp.line === line1Based ? { ...bp, ...patch } : bp))
    persistFileBreakpoints(filePath, next, get, set)
    await pushFileBreakpoints(filePath, next, set, get().breakpointsMuted)
  },

  removeBreakpoint: async (filePath, line1Based) => {
    const key = normalizeDebugPathKey(filePath)
    const current = get().breakpointsByFile[key] ?? []
    const next = current.filter((bp) => bp.line !== line1Based)
    persistFileBreakpoints(filePath, next, get, set)
    await pushFileBreakpoints(filePath, next, set, get().breakpointsMuted)
  },

  remapFileBreakpoints: (filePath, next) => {
    persistFileBreakpoints(filePath, next, get, set)
    void pushFileBreakpoints(filePath, next, set, get().breakpointsMuted)
  },

  startSession: async (config) => {
    installDebugEventListener(createDebugSessionEventHandlers(get, set))
    if (!isTauriNativeHost()) {
      set({
        panelOpen: true,
        lastError: 'DAP 调试引擎需要运行在 Orca 桌面客户端（Tauri Host）中。'
      })
      return
    }
    if (get().activeSessionId !== null) {
      await get().stopSession()
    }
    set({
      status: 'starting',
      lastError: null,
      missingAdapterOffer: null,
      threads: [],
      frames: [],
      scopes: [],
      variablesByRef: {},
      capabilities: null,
      exceptionFilters: [],
      supportsProgramInput: false,
      stoppedLocation: null,
      smartStep: null,
      panelOpen: true,
      consoleLines: [createConsoleEntry('system', `Starting ${config.adapter}: ${config.name}\n`)]
    })
    await syncStoredBreakpointsAndFilters(get, set, pushFileBreakpoints)
    try {
      const sid = await invokeNative<number>('poc_debug_start', { config })
      set((s) => {
        if (s.status === 'terminated') {
          return {}
        }
        const info: DebugSessionInfo = s.sessionsById[sid] ?? {
          id: sid,
          name: config.name,
          adapter: config.adapter,
          parent: null,
          status: s.status === 'stopped' ? 'stopped' : 'running'
        }
        const nextActive = s.activeSessionId ?? sid
        return {
          sessionsById: { ...s.sessionsById, [sid]: info },
          activeSessionId: nextActive,
          sessionId: nextActive,
          status: s.status === 'stopped' ? 'stopped' : 'running'
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set((s) => ({
        status: 'idle',
        activeSessionId: null,
        sessionId: null,
        lastError: msg,
        missingAdapterOffer: isMissingAdapterError(config.adapter, msg)
          ? { adapter: config.adapter, message: msg, config }
          : null,
        consoleLines: [...s.consoleLines, createConsoleEntry('stderr', `${msg}\n`)]
      }))
    }
  },

  stopSession: async () => {
    const sessions = Object.keys(get().sessionsById).map(Number)
    const active = get().activeSessionId
    const targets = active !== null && !sessions.includes(active) ? [active, ...sessions] : sessions
    set({
      sessionsById: {},
      activeSessionId: null,
      sessionId: null,
      status: 'idle',
      threads: [],
      activeThreadId: null,
      activeFrameId: null,
      frames: [],
      scopes: [],
      variablesByRef: {},
      capabilities: null,
      exceptionFilters: [],
      supportsProgramInput: false,
      stoppedLocation: null,
      smartStep: null
    })
    if (isTauriNativeHost()) {
      for (const sid of targets) {
        await invokeNative('poc_debug_stop', { session: sid }).catch(() => {})
      }
    }
  },

  ...createDebugExecutionActions(set, get),
  ...createDebugEvaluationActions(set, get),
  ...createDebugManagementActions(set, get)
}))
