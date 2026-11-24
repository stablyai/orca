import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { DebugGet, DebugSessionState, DebugSet } from './debug-session-lifecycle'
import { navigateToSourceLocation, normalizeDebugPathKey } from './debug-session-paths'
import { createDebugSmartStepActions } from './debug-session-smart-step'
import type {
  DebugCapabilities,
  DebugScope,
  DebugStackFrame,
  DebugThreadInfo,
  DebugVariable
} from './debug-session-types'

async function runThreadStep(command: string, get: DebugGet, set: DebugSet): Promise<void> {
  const { activeSessionId, activeThreadId } = get()
  if (activeSessionId === null) {
    return
  }
  await invokeNative(command, {
    session: activeSessionId,
    threadId: activeThreadId ?? 1
  }).catch((err) => set({ lastError: err instanceof Error ? err.message : String(err) }))
}

export type DebugExecutionActions = Pick<
  DebugSessionState,
  | 'selectSession'
  | 'selectThread'
  | 'resume'
  | 'pause'
  | 'stepOver'
  | 'stepInto'
  | 'stepOut'
  | 'runToCursor'
  | 'startSmartStepInto'
  | 'selectSmartStepIndex'
  | 'chooseSmartStepTarget'
  | 'cancelSmartStep'
  | 'selectFrame'
  | 'expandVariables'
  | 'setVariable'
>

export function createDebugExecutionActions(set: DebugSet, get: DebugGet): DebugExecutionActions {
  return {
    selectSession: async (sessionId) => {
      const info = get().sessionsById[sessionId]
      if (!info) {
        return
      }
      set({
        activeSessionId: sessionId,
        sessionId,
        status: info.status,
        supportsProgramInput: Boolean(info.supportsProgramInput),
        frames: [],
        scopes: [],
        activeFrameId: null,
        stoppedLocation: null,
        smartStep: null
      })
      if (!isTauriNativeHost()) {
        return
      }
      const [threads, capabilities] = await Promise.all([
        invokeNative<DebugThreadInfo[]>('poc_debug_threads', { session: sessionId }).catch(
          () => []
        ),
        invokeNative<DebugCapabilities>('poc_debug_capabilities', { session: sessionId }).catch(
          () => null
        )
      ])
      set({ threads, capabilities })
      if (info.status === 'stopped' && threads[0]) {
        await get().selectThread(threads[0].id)
      }
    },

    selectThread: async (threadId) => {
      const sid = get().activeSessionId
      set({ activeThreadId: threadId, smartStep: null })
      if (sid === null || !isTauriNativeHost()) {
        return
      }
      try {
        const frames = await invokeNative<DebugStackFrame[]>('poc_debug_stack_trace', {
          session: sid,
          threadId
        })
        const top = frames[0]
        set({
          frames,
          activeFrameId: top?.id ?? null,
          stoppedLocation: top?.path
            ? { fileKey: normalizeDebugPathKey(top.path), filePath: top.path, line: top.line }
            : null
        })
        if (top) {
          await get().selectFrame(top.id, true)
        }
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    resume: async () => {
      set({ status: 'running', stoppedLocation: null, smartStep: null })
      await runThreadStep('poc_debug_resume', get, set)
    },
    pause: () => runThreadStep('poc_debug_pause', get, set),
    stepOver: () => {
      set({ smartStep: null })
      return runThreadStep('poc_debug_step_over', get, set)
    },
    stepInto: () => {
      set({ smartStep: null })
      return runThreadStep('poc_debug_step_into', get, set)
    },
    stepOut: () => {
      set({ smartStep: null })
      return runThreadStep('poc_debug_step_out', get, set)
    },

    runToCursor: async (filePath, line1Based, force = false) => {
      const { activeSessionId, activeThreadId } = get()
      if (activeSessionId === null || !isTauriNativeHost()) {
        return
      }
      set({ status: 'running', stoppedLocation: null, smartStep: null })
      await invokeNative('poc_debug_run_to', {
        session: activeSessionId,
        threadId: activeThreadId ?? 1,
        path: filePath,
        line: line1Based,
        force
      }).catch((err) => set({ lastError: err instanceof Error ? err.message : String(err) }))
    },

    ...createDebugSmartStepActions(set, get),

    selectFrame: async (frameId, navigate = true) => {
      const { activeSessionId, frames } = get()
      set({ activeFrameId: frameId })
      if (navigate) {
        const target = frames.find((f) => f.id === frameId)
        if (target?.path) {
          set({
            stoppedLocation: {
              fileKey: normalizeDebugPathKey(target.path),
              filePath: target.path,
              line: target.line
            }
          })
          navigateToSourceLocation(target.path, target.line, target.column)
        }
      }
      if (activeSessionId === null) {
        return
      }
      try {
        const scopes = await invokeNative<DebugScope[]>('poc_debug_scopes', {
          session: activeSessionId,
          frameId
        })
        set({ scopes })
        const nonExpensive = scopes.filter((s) => !s.expensive).slice(0, 3)
        const expandList = nonExpensive.length > 0 ? nonExpensive : scopes.slice(0, 1)
        await Promise.all(
          expandList.map((scope) => get().expandVariables(scope.variablesReference))
        )
        void get().refreshWatches()
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    expandVariables: async (reference) => {
      const { activeSessionId } = get()
      if (activeSessionId === null || reference <= 0) {
        return
      }
      try {
        const vars = await invokeNative<DebugVariable[]>('poc_debug_variables', {
          session: activeSessionId,
          reference
        })
        set((s) => ({ variablesByRef: { ...s.variablesByRef, [reference]: vars } }))
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    setVariable: async (container, name, value, evaluateName = null) => {
      const { activeSessionId, activeFrameId } = get()
      if (activeSessionId === null || !isTauriNativeHost()) {
        return
      }
      try {
        const updated = await invokeNative<DebugVariable>('poc_debug_set_variable', {
          session: activeSessionId,
          container,
          name,
          evaluateName,
          frameId: activeFrameId,
          value
        })
        set((s) => {
          const list = s.variablesByRef[container]
          if (!list) {
            return {}
          }
          return {
            variablesByRef: {
              ...s.variablesByRef,
              [container]: list.map((v) => (v.name === name ? updated : v))
            }
          }
        })
        void get().refreshWatches()
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}
