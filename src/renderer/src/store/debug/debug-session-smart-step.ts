import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import type { DebugGet, DebugSessionState, DebugSet } from './debug-session-lifecycle'
import type { DebugStepInTarget } from './debug-session-types'
import { locateStepTargets, targetsOnLine } from './debug-smart-step-match'

export type DebugSmartStepActions = Pick<
  DebugSessionState,
  'startSmartStepInto' | 'selectSmartStepIndex' | 'chooseSmartStepTarget' | 'cancelSmartStep'
>

export function createDebugSmartStepActions(set: DebugSet, get: DebugGet): DebugSmartStepActions {
  return {
    startSmartStepInto: async (lineContext) => {
      const {
        activeSessionId,
        activeThreadId,
        activeFrameId,
        status,
        capabilities,
        stoppedLocation
      } = get()
      if (
        activeSessionId === null ||
        activeFrameId === null ||
        status !== 'stopped' ||
        !isTauriNativeHost()
      ) {
        return
      }
      if (!capabilities?.stepInTargets) {
        await get().stepInto()
        return
      }
      try {
        const raw = await invokeNative<DebugStepInTarget[]>('poc_debug_step_in_targets', {
          session: activeSessionId,
          frameId: activeFrameId
        })
        const matchesLine =
          lineContext != null &&
          stoppedLocation != null &&
          stoppedLocation.fileKey === lineContext.fileKey &&
          stoppedLocation.line === lineContext.line
        const targets = matchesLine ? targetsOnLine(lineContext.text, lineContext.line, raw) : raw
        if (targets.length === 0) {
          await get().stepInto()
          return
        }
        const threadId = activeThreadId ?? 1
        if (targets.length === 1 && targets[0]) {
          set({ status: 'running', stoppedLocation: null, smartStep: null })
          await invokeNative('poc_debug_step_in_target', {
            session: activeSessionId,
            threadId,
            targetId: targets[0].id
          })
          return
        }
        const ranges = matchesLine
          ? locateStepTargets(lineContext.text, lineContext.line, targets)
          : null
        const firstId = targets[0]?.id
        const idx = ranges ? ranges.findIndex((r) => r.id === firstId) : -1
        set({
          smartStep: {
            sessionId: activeSessionId,
            threadId,
            targets,
            inline:
              ranges && ranges.length >= 2 && lineContext
                ? {
                    fileKey: lineContext.fileKey,
                    line: lineContext.line,
                    ranges,
                    index: idx !== -1 ? idx : 0
                  }
                : null
          }
        })
      } catch (err) {
        set({ lastError: err instanceof Error ? err.message : String(err) })
      }
    },

    selectSmartStepIndex: (index) =>
      set((s) => {
        if (!s.smartStep?.inline) {
          return {}
        }
        const count = s.smartStep.inline.ranges.length
        return {
          smartStep: {
            ...s.smartStep,
            inline: { ...s.smartStep.inline, index: ((index % count) + count) % count }
          }
        }
      }),

    chooseSmartStepTarget: async (targetId) => {
      const current = get().smartStep
      if (!current) {
        return
      }
      const resolved =
        targetId ??
        (current.inline ? current.inline.ranges[current.inline.index]?.id : current.targets[0]?.id)
      set({ smartStep: null })
      if (resolved == null || !isTauriNativeHost()) {
        return
      }
      set({ status: 'running', stoppedLocation: null })
      await invokeNative('poc_debug_step_in_target', {
        session: current.sessionId,
        threadId: current.threadId,
        targetId: resolved
      }).catch((err) => set({ lastError: err instanceof Error ? err.message : String(err) }))
    },

    cancelSmartStep: () => set({ smartStep: null })
  }
}
