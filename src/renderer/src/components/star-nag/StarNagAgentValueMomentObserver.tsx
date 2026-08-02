import { useCallback, useEffect, useRef } from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { useAppStore } from '@/store'

// Why: leave a short quiet window after agents finish so the prompt does not
// interrupt follow-up typing or status churn from the completed run.
const QUIET_WINDOW_MS = 1200
const CHECK_DELAY_MS = 1200
const ACTIVE_AGENT_STATES = new Set(['working', 'waiting', 'blocked'])
const NON_TYPING_MODIFIER_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

type AgentStatusSnapshot = Record<string, AgentStatusEntry>
type AgentValueMomentPreparation = Awaited<ReturnType<typeof window.api.starNag.agentValueMoment>>

function hasMeaningfulPrompt(entry: AgentStatusEntry): boolean {
  if (entry.prompt.trim()) {
    return true
  }
  return entry.stateHistory.some((history) => history.prompt.trim())
}

function hasActiveAgent(entries: AgentStatusSnapshot): boolean {
  return Object.values(entries).some((entry) => ACTIVE_AGENT_STATES.has(entry.state))
}

function hasSuccessfulDoneTransition(
  previous: AgentStatusSnapshot,
  current: AgentStatusSnapshot
): boolean {
  for (const [paneKey, entry] of Object.entries(current)) {
    const previousEntry = previous[paneKey]
    if (
      previousEntry &&
      previousEntry.state !== 'done' &&
      entry.state === 'done' &&
      !entry.interrupted &&
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
  // Why: agentStatusByPaneKey is re-spread to a new object on every status ping
  // (including high-frequency still-working pings that never change what we
  // detect), so subscribing to the map re-rendered this always-mounted observer
  // — and re-ran the app-wide done-transition scan — on every ping. agentStatusEpoch
  // bumps on exactly the state transitions we care about, so drive off the epoch
  // and read the map imperatively via getState().
  const agentStatusEpoch = useAppStore((state) => state.agentStatusEpoch)
  const previousEntriesRef = useRef<AgentStatusSnapshot | null>(null)
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
        hasActiveAgent(useAppStore.getState().agentStatusByPaneKey) ||
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
          hasActiveAgent(useAppStore.getState().agentStatusByPaneKey) ||
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
    window.addEventListener('keydown', markTyping, true)
    window.addEventListener('input', markTyping, true)
    return () => {
      window.removeEventListener('keydown', markTyping, true)
      window.removeEventListener('input', markTyping, true)
    }
  }, [])

  useEffect(() => {
    const currentEntries = useAppStore.getState().agentStatusByPaneKey
    const previousEntries = previousEntriesRef.current
    previousEntriesRef.current = currentEntries
    if (!previousEntries || requestedRef.current) {
      return
    }
    if (!hasSuccessfulDoneTransition(previousEntries, currentEntries)) {
      return
    }
    pendingRef.current = true
    scheduleCheck()
  }, [agentStatusEpoch, scheduleCheck])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return null
}
