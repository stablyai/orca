import { useCallback, useEffect, useRef } from 'react'
import type { AgentStatusChange } from '@/store/slices/agent-status/agent-status-contract'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { useAppStore } from '@/store'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/keyboard/app-keyboard-router'

// Leave a quiet window after completion so prompts cannot interrupt follow-up typing or status churn.
const QUIET_WINDOW_MS = 1200
const CHECK_DELAY_MS = 1200
const NON_TYPING_MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

type AgentValueMomentPreparation = Awaited<ReturnType<typeof window.api.starNag.agentValueMoment>>

function hasMeaningfulPrompt(entry: AgentStatusEntry): boolean {
  if (entry.prompt.trim()) {
    return true
  }
  return entry.stateHistory.some((history) => history.prompt.trim())
}

function hasSuccessfulDoneTransition(changes: readonly AgentStatusChange[]): boolean {
  for (const { previous: previousEntry, current: entry } of changes) {
    if (
      previousEntry &&
      entry &&
      previousEntry.state !== 'done' &&
      entry.state === 'done' &&
      // Session-boundary done is idle connection, not completed work; resume must not trigger a launch-time nag.
      entry.sessionBoundary !== true &&
      !agentTurnEndedUncleanly(entry) &&
      // A new done, not a return to one dated before the work it ended (a command at rest).
      entry.stateStartedAt >= previousEntry.stateStartedAt &&
      hasMeaningfulPrompt(entry)
    ) {
      return true
    }
  }
  return false
}

function isTypingKeyEvent(event: KeyboardEvent): boolean {
  return !NON_TYPING_MODIFIER_KEYS.has(event.key)
}

export function StarNagAgentValueMomentObserver(): null {
  const projection = useAppStore((state) => state.agentStatusByPaneKey.projection)
  const pendingRef = useRef(false)
  const requestedRef = useRef(false)
  const preparationRef = useRef<AgentValueMomentPreparation | null>(null)
  const lastTypingAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleCheck = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!pendingRef.current || requestedRef.current) {
        return
      }
      const elapsedSinceTyping = Date.now() - lastTypingAtRef.current
      if (
        useAppStore.getState().agentStatusByPaneKey.projection.hasActiveAgents() ||
        elapsedSinceTyping < QUIET_WINDOW_MS
      ) {
        scheduleCheck()
        return
      }
      void (async () => {
        if (!preparationRef.current) {
          preparationRef.current = await window.api.starNag.agentValueMoment()
          if (preparationRef.current.status !== 'ready') {
            pendingRef.current = false
            requestedRef.current = true
            return
          }
        }
        const freshElapsedSinceTyping = Date.now() - lastTypingAtRef.current
        if (
          useAppStore.getState().agentStatusByPaneKey.projection.hasActiveAgents() ||
          freshElapsedSinceTyping < QUIET_WINDOW_MS
        ) {
          scheduleCheck()
          return
        }
        pendingRef.current = false
        requestedRef.current = true
        await window.api.starNag.showAgentValueMoment()
      })()
    }, CHECK_DELAY_MS)
  }, [])

  useEffect(() => {
    const markTyping = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        if (!isTypingKeyEvent(event)) {
          return
        }
      }
      lastTypingAtRef.current = Date.now()
    }
    addAppKeyListener('keydown', markTyping)
    window.addEventListener('input', markTyping, true)
    return () => {
      removeAppKeyListener('keydown', markTyping)
      window.removeEventListener('input', markTyping, true)
    }
  }, [])

  useEffect(
    () =>
      projection.subscribeTransitions((changes) => {
        if (!requestedRef.current && hasSuccessfulDoneTransition(changes)) {
          pendingRef.current = true
          scheduleCheck()
        }
      }),
    [projection, scheduleCheck]
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return null
}
