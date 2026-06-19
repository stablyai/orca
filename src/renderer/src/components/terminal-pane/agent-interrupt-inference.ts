import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import {
  AGENT_INTERRUPT_SETTLE_MS,
  type AgentInterruptInferenceRequest,
  type AgentInterruptInputIntent
} from '../../../../shared/agent-interrupt-intent'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'

export type AgentInterruptInference = {
  observeInputIntent(intent: AgentInterruptInputIntent): void
  flushPending(): boolean | Promise<boolean>
  dispose(): void
}

type AgentInterruptInferenceDeps = {
  paneKey: string
  getStatusEntry: () => AgentStatusEntry | undefined
  inferInterrupt: (request: AgentInterruptInferenceRequest) => boolean | Promise<boolean> | void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

type CapturedInterruptBaseline = {
  updatedAt: number
  stateStartedAt: number
  prompt: string
  agentType: AgentStatusEntry['agentType']
  intent: AgentInterruptInputIntent
  inputCount?: number
}

function requiresDoubleEscapeForAgent(
  agentType: AgentStatusEntry['agentType'],
  intent: AgentInterruptInputIntent
): boolean {
  return (agentType === 'opencode' || agentType === 'copilot') && intent === 'plain-escape'
}

function shouldFlushInterruptImmediately(
  baseline: Pick<CapturedInterruptBaseline, 'agentType' | 'intent'>
): boolean {
  return (
    requiresDoubleEscapeForAgent(baseline.agentType, baseline.intent) ||
    baseline.agentType === 'gemini'
  )
}

function shouldIgnoreInterruptIntent(
  agentType: AgentStatusEntry['agentType'],
  intent: AgentInterruptInputIntent
): boolean {
  return agentType === 'droid' && intent === 'ctrl-c'
}

function isSameTurnBaseline(
  left: CapturedInterruptBaseline,
  right: CapturedInterruptBaseline
): boolean {
  return (
    left.agentType === right.agentType &&
    left.prompt === right.prompt &&
    left.stateStartedAt === right.stateStartedAt
  )
}

export function isPlainEscapeKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>
): boolean {
  return (
    event.key === 'Escape' &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function isCtrlCKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>
): boolean {
  return (
    event.key.toLowerCase() === 'c' &&
    !event.repeat &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

export function createAgentInterruptInference({
  paneKey,
  getStatusEntry,
  inferInterrupt,
  now = () => Date.now(),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer)
}: AgentInterruptInferenceDeps): AgentInterruptInference {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingBaseline: CapturedInterruptBaseline | null = null
  let doubleEscapeBaseline: CapturedInterruptBaseline | null = null
  let doubleEscapeTimer: ReturnType<typeof setTimeout> | null = null

  const clearPendingTimer = (): void => {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer)
      pendingTimer = null
    }
    pendingBaseline = null
  }

  const clearDoubleEscapeBaseline = (): void => {
    doubleEscapeBaseline = null
    if (doubleEscapeTimer !== null) {
      clearTimer(doubleEscapeTimer)
      doubleEscapeTimer = null
    }
  }

  const clearPending = (): void => {
    clearPendingTimer()
    clearDoubleEscapeBaseline()
  }

  const captureBaseline = (
    entry: AgentStatusEntry,
    intent: AgentInterruptInputIntent
  ): CapturedInterruptBaseline | null => {
    const agentType = entry.agentType
    if (
      entry.state !== 'working' ||
      !isExplicitAgentStatusFresh(entry, now(), AGENT_STATUS_STALE_AFTER_MS)
    ) {
      return null
    }
    return {
      updatedAt: entry.updatedAt,
      stateStartedAt: entry.stateStartedAt,
      prompt: entry.prompt,
      agentType,
      intent
    }
  }

  const flushPending = (): boolean | Promise<boolean> => {
    const baseline = pendingBaseline
    pendingTimer = null
    pendingBaseline = null
    if (!baseline) {
      return false
    }

    const entry = getStatusEntry()
    if (
      entry &&
      (entry.state !== 'working' ||
        entry.agentType !== baseline.agentType ||
        entry.prompt !== baseline.prompt ||
        entry.updatedAt !== baseline.updatedAt ||
        entry.stateStartedAt !== baseline.stateStartedAt ||
        !isExplicitAgentStatusFresh(entry, now(), AGENT_STATUS_STALE_AFTER_MS))
    ) {
      return false
    }
    if (!entry && now() - baseline.updatedAt > AGENT_STATUS_STALE_AFTER_MS) {
      return false
    }

    const result = inferInterrupt({
      paneKey,
      baselineUpdatedAt: baseline.updatedAt,
      baselineStateStartedAt: baseline.stateStartedAt,
      baselinePrompt: baseline.prompt,
      baselineAgentType: baseline.agentType,
      intent: baseline.intent,
      ...(baseline.inputCount !== undefined ? { inputCount: baseline.inputCount } : {})
    })
    return result ?? true
  }

  const flushPendingFromTimer = (): void => {
    void flushPending()
  }

  return {
    observeInputIntent(intent) {
      const entry = getStatusEntry()
      if (!entry) {
        clearPending()
        return
      }
      let baseline = captureBaseline(entry, intent)
      if (!baseline) {
        clearPending()
        return
      }
      if (shouldIgnoreInterruptIntent(baseline.agentType, intent)) {
        clearPending()
        return
      }
      if (requiresDoubleEscapeForAgent(baseline.agentType, intent)) {
        const isSecondEscape =
          doubleEscapeBaseline !== null && isSameTurnBaseline(doubleEscapeBaseline, baseline)
        doubleEscapeBaseline = baseline
        clearPendingTimer()
        if (!isSecondEscape) {
          if (doubleEscapeTimer !== null) {
            clearTimer(doubleEscapeTimer)
          }
          // Why: some TUIs use the first Escape as an editor/menu cancel. Do
          // not let that arm a later single Escape indefinitely.
          doubleEscapeTimer = setTimer(clearDoubleEscapeBaseline, AGENT_INTERRUPT_SETTLE_MS)
          return
        }
        clearDoubleEscapeBaseline()
        // Why: these agents use the first Escape as a TUI/editor cancel. The
        // second Escape on the same turn is the actual running-turn interrupt.
        baseline = { ...baseline, inputCount: 2 }
      } else {
        clearDoubleEscapeBaseline()
        clearPendingTimer()
      }
      pendingBaseline = baseline
      if (shouldFlushInterruptImmediately(baseline)) {
        // Why: these agents can emit their idle/done hook immediately after an
        // accepted interrupt. Flush before that hook overwrites the working baseline.
        void flushPending()
        return
      }
      pendingTimer = setTimer(flushPendingFromTimer, AGENT_INTERRUPT_SETTLE_MS)
    },
    flushPending,
    dispose() {
      clearPending()
    }
  }
}
