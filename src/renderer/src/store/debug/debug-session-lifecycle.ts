import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { DebugEventBridgeHandlers } from './debug-event-bridge'
import type { DebugManagementState } from './debug-session-management'
import { navigateToSourceLocation, normalizeDebugPathKey } from './debug-session-paths'
import {
  createConsoleEntry,
  type DebugBreakpoint,
  type DebugBreakpointState,
  type DebugCapabilities,
  type DebugConsoleEntry,
  type DebugDiscoveredLaunchConfig,
  type DebugEvalContext,
  type DebugLaunchConfig,
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

type DebugCoreSessionState = {
  breakpointsByFile: Record<string, DebugBreakpoint[]>
  breakpointPathsByKey: Record<string, string>
  breakpointStatesByFile: Record<string, DebugBreakpointState[]>
  breakpointsMuted: boolean
  sessionsById: Record<number, DebugSessionInfo>
  activeSessionId: number | null
  sessionId: number | null
  status: DebugSessionStatus
  threads: DebugThreadInfo[]
  activeThreadId: number | null
  activeFrameId: number | null
  frames: DebugStackFrame[]
  scopes: DebugScope[]
  variablesByRef: Record<number, DebugVariable[]>
  capabilities: DebugCapabilities | null
  exceptionFilters: DebugSessionExceptionFilters[]
  exceptionFilterChoices: Record<string, boolean>
  watches: DebugWatchEntry[]
  discoveredConfigs: DebugDiscoveredLaunchConfig[]
  supportsProgramInput: boolean
  stoppedLocation: { fileKey: string; filePath: string; line: number } | null
  smartStep: DebugSmartStepState | null
  consoleLines: DebugConsoleEntry[]
  lastError: string | null
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  setBreakpointsMuted: (muted: boolean) => Promise<void>
  toggleBreakpoint: (filePath: string, line1Based: number) => Promise<void>
  updateBreakpoint: (
    filePath: string,
    line1Based: number,
    patch: Partial<Omit<DebugBreakpoint, 'line'>>
  ) => Promise<void>
  removeBreakpoint: (filePath: string, line1Based: number) => Promise<void>
  remapFileBreakpoints: (filePath: string, next: DebugBreakpoint[]) => void
  startSession: (config: DebugLaunchConfig) => Promise<void>
  stopSession: () => Promise<void>
  selectSession: (sessionId: number) => Promise<void>
  selectThread: (threadId: number) => Promise<void>
  resume: () => Promise<void>
  pause: () => Promise<void>
  stepOver: () => Promise<void>
  stepInto: () => Promise<void>
  stepOut: () => Promise<void>
  runToCursor: (filePath: string, line1Based: number, force?: boolean) => Promise<void>
  startSmartStepInto: (
    lineContext?: { fileKey: string; line: number; text: string } | null
  ) => Promise<void>
  selectSmartStepIndex: (index: number) => void
  chooseSmartStepTarget: (targetId?: number) => Promise<void>
  cancelSmartStep: () => void
  selectFrame: (frameId: number, navigate?: boolean) => Promise<void>
  expandVariables: (reference: number) => Promise<void>
  setVariable: (
    container: number,
    name: string,
    value: string,
    evaluateName?: string | null
  ) => Promise<void>
  evaluateIn: (expression: string, context?: DebugEvalContext) => Promise<DebugVariable>
  evaluateExpression: (expression: string) => Promise<void>
  sendProgramInput: (text: string) => Promise<void>
  toggleExceptionFilter: (filterId: string) => Promise<void>
  addWatch: (expression: string) => Promise<void>
  removeWatch: (id: string) => void
  refreshWatches: () => Promise<void>
  refreshDiscoveredConfigs: (
    workspaceRoot?: string | null,
    activeFile?: string | null
  ) => Promise<void>
  clearConsole: () => void
}

export type DebugSessionState = DebugCoreSessionState & DebugManagementState

export type DebugSet = (
  partial: Partial<DebugSessionState> | ((s: DebugSessionState) => Partial<DebugSessionState>)
) => void
export type DebugGet = () => DebugSessionState

export async function pushFileBreakpoints(
  filePath: string,
  next: DebugBreakpoint[],
  set: DebugSet,
  muted = false
): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  const key = normalizeDebugPathKey(filePath)
  const payload = muted ? next.map((bp) => ({ ...bp, enabled: false })) : next
  try {
    const states = await invokeNative<DebugBreakpointState[]>('poc_debug_set_breakpoints', {
      path: filePath,
      breakpoints: payload
    })
    set((s) => ({ breakpointStatesByFile: { ...s.breakpointStatesByFile, [key]: states } }))
  } catch (err) {
    set({ lastError: err instanceof Error ? err.message : String(err) })
  }
}

export function createDebugSessionEventHandlers(
  get: DebugGet,
  set: DebugSet
): DebugEventBridgeHandlers {
  return {
    getActiveSessionId: () => get().activeSessionId,
    hasSession: (sid) => sid in get().sessionsById,
    onStarted: (sid, name, adapter, parent) =>
      set((s) => {
        const info: DebugSessionInfo = {
          id: sid,
          name,
          adapter,
          parent: parent ?? null,
          status: 'running'
        }
        const nextActive = s.activeSessionId === null ? sid : s.activeSessionId
        return {
          sessionsById: { ...s.sessionsById, [sid]: info },
          activeSessionId: nextActive,
          sessionId: nextActive
        }
      }),
    appendConsole: (entry) =>
      set((s) => ({ consoleLines: [...s.consoleLines.slice(-399), entry] })),
    onProgramInput: (sid) =>
      set((s) => {
        const existing = s.sessionsById[sid]
        const sessionsById = existing
          ? { ...s.sessionsById, [sid]: { ...existing, supportsProgramInput: true } }
          : s.sessionsById
        return {
          sessionsById,
          supportsProgramInput: sid === s.activeSessionId ? true : s.supportsProgramInput
        }
      }),
    onBreakpointsChanged: (path, states) =>
      set((s) => ({
        breakpointStatesByFile: {
          ...s.breakpointStatesByFile,
          [normalizeDebugPathKey(path)]: states
        }
      })),
    onContinued: (sid) =>
      set((s) => {
        const existing = s.sessionsById[sid]
        const sessionsById = existing
          ? { ...s.sessionsById, [sid]: { ...existing, status: 'running' as const } }
          : s.sessionsById
        if (sid !== s.activeSessionId) {
          return { sessionsById }
        }
        return { sessionsById, status: 'running', stoppedLocation: null, smartStep: null }
      }),
    onThreadChanged: (sid, threads) => {
      if (sid === get().activeSessionId) {
        set({ threads })
      }
    },
    onTerminated: (sid, exitCode) =>
      set((s) => {
        const nextSessions = { ...s.sessionsById }
        delete nextSessions[sid]
        const remaining = Object.values(nextSessions)
        const nextLines =
          exitCode !== undefined
            ? [...s.consoleLines, createConsoleEntry('system', `Process exited (${exitCode})\n`)]
            : s.consoleLines
        if (remaining.length > 0) {
          const nextActive =
            s.activeSessionId === sid ? (remaining.at(-1)?.id ?? null) : s.activeSessionId
          const nextInfo = nextActive !== null ? nextSessions[nextActive] : undefined
          return {
            sessionsById: nextSessions,
            activeSessionId: nextActive,
            sessionId: nextActive,
            status: nextInfo?.status ?? s.status,
            supportsProgramInput: Boolean(nextInfo?.supportsProgramInput),
            smartStep: null,
            consoleLines: nextLines
          }
        }
        return {
          sessionsById: {},
          activeSessionId: null,
          sessionId: null,
          status: 'terminated',
          threads: [],
          activeThreadId: null,
          activeFrameId: null,
          frames: [],
          scopes: [],
          capabilities: null,
          exceptionFilters: [],
          supportsProgramInput: false,
          stoppedLocation: null,
          smartStep: null,
          consoleLines: nextLines
        }
      }),
    onStopped: async ({ sessionId, threadId, threads, frames, capabilities, exceptionFilters }) => {
      const top = frames[0]
      set((s) => {
        const existing = s.sessionsById[sessionId]
        const sessionsById = existing
          ? { ...s.sessionsById, [sessionId]: { ...existing, status: 'stopped' as const } }
          : s.sessionsById
        return {
          sessionsById,
          activeSessionId: sessionId,
          sessionId,
          status: 'stopped',
          threads,
          activeThreadId: threadId,
          activeFrameId: top?.id ?? null,
          frames,
          capabilities: capabilities ?? s.capabilities,
          exceptionFilters,
          supportsProgramInput: Boolean(sessionsById[sessionId]?.supportsProgramInput),
          smartStep: null,
          stoppedLocation: top?.path
            ? { fileKey: normalizeDebugPathKey(top.path), filePath: top.path, line: top.line }
            : null
        }
      })
      if (top) {
        if (top.path) {
          navigateToSourceLocation(top.path, top.line, top.column)
        }
        await get().selectFrame(top.id, false)
      }
    },
    onError: (lastError) => set({ lastError })
  }
}
