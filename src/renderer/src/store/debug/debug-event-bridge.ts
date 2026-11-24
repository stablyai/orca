import { invokeNative, listenNative } from '@/web/tauri-native-host'
import {
  createConsoleEntry,
  type DebugBreakpointState,
  type DebugCapabilities,
  type DebugConsoleEntry,
  type DebugEventPayload,
  type DebugSessionExceptionFilters,
  type DebugStackFrame,
  type DebugThreadInfo
} from './debug-session-types'

export type DebugEventBridgeHandlers = {
  getActiveSessionId: () => number | null
  hasSession: (sessionId: number) => boolean
  onStarted: (sessionId: number, name: string, adapter: string, parent?: number | null) => void
  appendConsole: (entry: DebugConsoleEntry) => void
  onProgramInput: (sessionId: number) => void
  onBreakpointsChanged: (path: string, states: DebugBreakpointState[]) => void
  onContinued: (sessionId: number) => void
  onThreadChanged: (sessionId: number, threads: DebugThreadInfo[]) => void
  onTerminated: (sessionId: number, exitCode?: number) => void
  onStopped: (params: {
    sessionId: number
    threadId: number
    threads: DebugThreadInfo[]
    frames: DebugStackFrame[]
    capabilities: DebugCapabilities | null
    exceptionFilters: DebugSessionExceptionFilters[]
  }) => Promise<void>
  onError: (msg: string) => void
}

let listenerInstalled = false

export function installDebugEventListener(ops: DebugEventBridgeHandlers): void {
  if (listenerInstalled) {
    return
  }
  listenerInstalled = true
  listenNative<DebugEventPayload>('debug:event', (payload) => {
    const sid = payload.session
    const ev = payload.event

    if (ev.kind === 'started') {
      ops.onStarted(sid, ev.name, ev.adapter, ev.parent)
      return
    }

    const activeId = ops.getActiveSessionId()
    const knownSession = ops.hasSession(sid) || activeId === sid
    if (!knownSession && activeId !== null) {
      return
    }

    if (ev.kind === 'output') {
      ops.appendConsole(createConsoleEntry(ev.category, ev.output))
      return
    }
    if (ev.kind === 'programInput') {
      ops.onProgramInput(sid)
      return
    }
    if (ev.kind === 'breakpointsChanged') {
      void invokeNative<DebugBreakpointState[]>('poc_debug_breakpoint_states', { path: ev.path })
        .then((states) => ops.onBreakpointsChanged(ev.path, states))
        .catch(() => {})
      return
    }
    if (ev.kind === 'continued') {
      ops.onContinued(sid)
      return
    }
    if (ev.kind === 'terminated' || ev.kind === 'exited') {
      ops.onTerminated(sid, ev.kind === 'exited' ? ev.code : undefined)
      return
    }
    if (ev.kind === 'thread') {
      if (sid === ops.getActiveSessionId()) {
        void invokeNative<DebugThreadInfo[]>('poc_debug_threads', { session: sid })
          .then((threads) => ops.onThreadChanged(sid, threads))
          .catch(() => {})
      }
      return
    }
    if (ev.kind === 'stopped') {
      void (async () => {
        try {
          const [threads, frames, capabilities, exceptionFilters] = await Promise.all([
            invokeNative<DebugThreadInfo[]>('poc_debug_threads', { session: sid }).catch(() => []),
            invokeNative<DebugStackFrame[]>('poc_debug_stack_trace', {
              session: sid,
              threadId: ev.threadId
            }),
            invokeNative<DebugCapabilities>('poc_debug_capabilities', { session: sid }).catch(
              () => null
            ),
            invokeNative<DebugSessionExceptionFilters[]>('poc_debug_exception_filters').catch(
              () => []
            )
          ])
          await ops.onStopped({
            sessionId: sid,
            threadId: ev.threadId,
            threads,
            frames,
            capabilities,
            exceptionFilters
          })
        } catch (err) {
          ops.onError(err instanceof Error ? err.message : String(err))
        }
      })()
    }
  })
}
