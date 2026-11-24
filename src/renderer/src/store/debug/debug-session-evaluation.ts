import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { DebugGet, DebugSessionState, DebugSet } from './debug-session-lifecycle'
import { savePersistedWatches } from './debug-session-paths'
import {
  createConsoleEntry,
  type DebugDiscoveredLaunchConfig,
  type DebugVariable,
  type DebugWatchEntry
} from './debug-session-types'

export type DebugEvaluationActions = Pick<
  DebugSessionState,
  | 'evaluateIn'
  | 'evaluateExpression'
  | 'sendProgramInput'
  | 'toggleExceptionFilter'
  | 'addWatch'
  | 'removeWatch'
  | 'refreshWatches'
  | 'refreshDiscoveredConfigs'
>

export function createDebugEvaluationActions(set: DebugSet, get: DebugGet): DebugEvaluationActions {
  return {
    evaluateIn: async (expression, context = 'repl') => {
      const { activeSessionId, activeFrameId } = get()
      if (activeSessionId === null) {
        throw new Error('No active debug session.')
      }
      return invokeNative<DebugVariable>('poc_debug_evaluate_in', {
        session: activeSessionId,
        frameId: activeFrameId,
        expression,
        context
      })
    },

    evaluateExpression: async (expression) => {
      const trimmed = expression.trim()
      const { activeSessionId, supportsProgramInput } = get()
      if (!trimmed) {
        return
      }
      if (activeSessionId === null) {
        set((s) => ({
          consoleLines: [
            ...s.consoleLines,
            createConsoleEntry('stderr', 'No active debug session.\n')
          ]
        }))
        return
      }
      if (supportsProgramInput && get().status === 'running') {
        await get().sendProgramInput(`${expression}\n`)
        return
      }
      try {
        const result = await get().evaluateIn(trimmed, 'repl')
        set((s) => ({
          consoleLines: [
            ...s.consoleLines,
            createConsoleEntry('input', `> ${trimmed}\n`),
            createConsoleEntry(
              'result',
              `${result.value}${result.typeName ? ` (${result.typeName})` : ''}\n`
            )
          ]
        }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        set((s) => ({
          consoleLines: [
            ...s.consoleLines,
            createConsoleEntry('input', `> ${trimmed}\n`),
            createConsoleEntry('stderr', `${msg}\n`)
          ]
        }))
      }
    },

    sendProgramInput: async (text) => {
      const sid = get().activeSessionId
      if (sid === null || !isTauriNativeHost()) {
        return
      }
      set((s) => ({
        consoleLines: [...s.consoleLines, createConsoleEntry('input', text)]
      }))
      await invokeNative('poc_debug_send_input', { session: sid, text }).catch((err) =>
        set({ lastError: err instanceof Error ? err.message : String(err) })
      )
    },

    toggleExceptionFilter: async (filterId) => {
      const next = {
        ...get().exceptionFilterChoices,
        [filterId]: !(get().exceptionFilterChoices[filterId] ?? false)
      }
      set({ exceptionFilterChoices: next })
      if (isTauriNativeHost()) {
        await invokeNative('poc_debug_set_exception_breakpoints', { choices: next }).catch((err) =>
          set({ lastError: err instanceof Error ? err.message : String(err) })
        )
      }
    },

    addWatch: async (expression) => {
      const trimmed = expression.trim()
      if (!trimmed) {
        return
      }
      const entry: DebugWatchEntry = { id: `watch-${Date.now()}-${trimmed}`, expression: trimmed }
      const next = [...get().watches, entry]
      savePersistedWatches(next)
      set({ watches: next })
      await get().refreshWatches()
    },

    removeWatch: (id) => {
      const next = get().watches.filter((w) => w.id !== id)
      savePersistedWatches(next)
      set({ watches: next })
    },

    refreshWatches: async () => {
      const { activeSessionId, status, watches } = get()
      if (activeSessionId === null || status !== 'stopped' || watches.length === 0) {
        return
      }
      const updated = await Promise.all(
        watches.map(async (w) => {
          try {
            const res = await get().evaluateIn(w.expression, 'watch')
            return {
              ...w,
              value: res.value,
              typeName: res.typeName,
              variablesReference: res.variablesReference,
              error: undefined
            }
          } catch (err) {
            return {
              ...w,
              value: undefined,
              error: err instanceof Error ? err.message : String(err)
            }
          }
        })
      )
      set({ watches: updated })
    },

    refreshDiscoveredConfigs: async (workspaceRoot, activeFile) => {
      if (!isTauriNativeHost()) {
        return
      }
      try {
        const discoveredConfigs = await invokeNative<DebugDiscoveredLaunchConfig[]>(
          'poc_debug_discover_launch_configs',
          {
            workspaceRoot: workspaceRoot ?? null,
            activeFile: activeFile ?? null
          }
        )
        set({ discoveredConfigs })
      } catch {
        // Non-fatal: manual launch config stays available.
      }
    }
  }
}
