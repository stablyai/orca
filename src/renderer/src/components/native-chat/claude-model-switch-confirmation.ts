import type { GlobalSettings } from '../../../../shared/types'
import { subscribeToPtyData } from '../terminal-pane/pty-data-sidecar-subscriptions'
import { isRemoteRuntimePtyId, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { NATIVE_CHAT_SUBMIT } from './native-chat-send'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const DETECTION_TIMEOUT_MS = 5_000
const MAX_OBSERVED_BYTES = 64 * 1024

type SubscribeToData = (watcher: (data: string) => void) => Promise<() => void> | (() => void)

export type ClaudeModelSwitchOutcome = 'applied' | 'rejected' | 'interaction-required' | 'unknown'

export type ClaudeModelSwitchConfirmationObserver = {
  ready: Promise<void>
  result: Promise<ClaudeModelSwitchOutcome>
  arm(): void
  startDetection(): void
  dispose(): void
}

export function hasClaudeModelSwitchConfirmation(buffer: string): boolean {
  const text = compactTerminalText(buffer)
  return (
    text.includes('switchmodel?') && text.includes('thisconversationiscachedforthecurrentmodel')
  )
}

function compactTerminalText(buffer: string): string {
  // Why: Claude positions TUI words with cursor-column escapes instead of
  // emitting literal spaces, so matching must not depend on rendered gaps.
  return stripScrollbackAnsi(buffer).replace(/\s+/g, '').toLowerCase()
}

function hasClaudeModelSwitchSuccess(buffer: string, modelLabel: string): boolean {
  const text = compactTerminalText(buffer)
  const marker = `setmodelto${modelLabel.replace(/\s+/g, '').toLowerCase()}`
  return text.includes(marker)
}

function hasClaudeModelSwitchRejection(buffer: string): boolean {
  return compactTerminalText(buffer).includes('keptmodelas')
}

function hasClaudeModelSwitchInteraction(buffer: string): boolean {
  const text = compactTerminalText(buffer)
  return (
    text.includes('fable5usesusagecreditsandneedsaone-timeconsent') ||
    text.includes('pickfablefrom/modelinaninteractivesessiontosetitup') ||
    (text.includes('switchtofable5?') && text.includes('usagecredits'))
  )
}

function subscribeToClaudeModelSwitchData(args: {
  ptyId: string
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  subscribeToData?: SubscribeToData
  watcher: (data: string) => void
}): Promise<() => void> | (() => void) {
  if (args.subscribeToData) {
    return args.subscribeToData(args.watcher)
  }
  if (isRemoteRuntimePtyId(args.ptyId)) {
    return subscribeToRuntimeTerminalData(
      args.settings,
      args.ptyId,
      `desktop:native-chat-model-switch:${args.ptyId}`,
      args.watcher,
      { startAtLiveTail: true }
    )
  }
  return subscribeToPtyData(args.ptyId, args.watcher)
}

export function createClaudeModelSwitchConfirmationObserver(args: {
  ptyId: string
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  expectedModelLabel: string | null
  subscribeToData?: SubscribeToData
  submitConfirmation?: () => boolean | void
  timeoutMs?: number
}): ClaudeModelSwitchConfirmationObserver {
  let armed = false
  let settled = false
  let confirmationSubmitted = false
  let observed = ''
  let timeout: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let resolveResult!: (outcome: ClaudeModelSwitchOutcome) => void
  let resolveReady!: () => void
  const result = new Promise<ClaudeModelSwitchOutcome>((resolve) => {
    resolveResult = resolve
  })
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const finish = (outcome: ClaudeModelSwitchOutcome): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
    unsubscribe?.()
    unsubscribe = null
    resolveResult(outcome)
  }

  const scheduleTimeout = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => finish('unknown'), args.timeoutMs ?? DETECTION_TIMEOUT_MS)
  }

  const observeData = (data: string): void => {
    if (!armed || settled) {
      return
    }
    observed = `${observed}${data}`.slice(-MAX_OBSERVED_BYTES)
    if (args.expectedModelLabel && hasClaudeModelSwitchSuccess(observed, args.expectedModelLabel)) {
      finish('applied')
      return
    }
    if (hasClaudeModelSwitchRejection(observed)) {
      finish('rejected')
      return
    }
    if (hasClaudeModelSwitchInteraction(observed)) {
      finish('interaction-required')
      return
    }
    if (!confirmationSubmitted && hasClaudeModelSwitchConfirmation(observed)) {
      confirmationSubmitted = true
      try {
        // Why: the picker selection already expresses consent to switch; this
        // exact Claude warning defaults to “Yes” and needs only one Enter.
        const accepted = args.submitConfirmation
          ? args.submitConfirmation() !== false
          : sendRuntimePtyInput(args.settings, args.ptyId, NATIVE_CHAT_SUBMIT)
        if (!accepted) {
          finish('unknown')
          return
        }
        scheduleTimeout()
      } catch {
        finish('unknown')
      }
    }
  }

  try {
    const subscription = subscribeToClaudeModelSwitchData({
      ptyId: args.ptyId,
      settings: args.settings,
      subscribeToData: args.subscribeToData,
      watcher: observeData
    })
    void Promise.resolve(subscription)
      .then((dispose) => {
        if (settled) {
          dispose()
        } else {
          unsubscribe = dispose
        }
      })
      .catch(() => finish('unknown'))
      .finally(resolveReady)
  } catch {
    finish('unknown')
    resolveReady()
  }

  return {
    ready,
    result,
    arm: () => {
      if (settled || armed) {
        return
      }
      armed = true
    },
    startDetection: () => {
      // Why: measure the detection window from when the command is actually
      // delivered, not from arm(). On SSH/remote the body+Enter round-trips can
      // otherwise burn the timeout before the agent has even responded, turning
      // a successful switch into a false "could not verify the model change".
      if (settled) {
        return
      }
      scheduleTimeout()
    },
    dispose: () => finish('unknown')
  }
}
