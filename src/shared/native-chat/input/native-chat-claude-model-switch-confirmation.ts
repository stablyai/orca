import { stripScrollbackAnsi } from '../../terminal/output/terminal-safe-text'
import type { ClaudeModelSwitchOutcome } from './native-chat-session-option-dispatch'

const DETECTION_TIMEOUT_MS = 5_000
const MAX_OBSERVED_BYTES = 64 * 1024

export type SubscribeToData = (
  watcher: (data: string) => void
) => Promise<() => void> | (() => void)

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
  // Cursor-column escapes replace literal TUI spaces, so match independently of rendered gaps.
  return stripScrollbackAnsi(buffer).replace(/\s+/g, '').toLowerCase()
}

function hasClaudeModelSwitchSuccess(buffer: string, modelLabel: string): boolean {
  const text = compactTerminalText(buffer)
  // Claude echoes neither the vendor prefix nor Orca's picker-only `alias` suffix.
  const label = modelLabel.replace(/^claude[\s-]+/i, '').replace(/\s+alias$/i, '')
  const marker = `setmodelto${label.replace(/\s+/g, '').toLowerCase()}`
  if (text.includes(marker)) {
    return true
  }
  // Match every picker token so a versioned echo cannot confirm the wrong context variant.
  const labelTokens = label.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? []
  const successStart = text.lastIndexOf('setmodelto')
  if (successStart === -1 || labelTokens.length === 0) {
    return false
  }
  const successText = text.slice(successStart)
  let tokenEnd = 0
  for (const token of labelTokens) {
    const tokenStart = successText.indexOf(token, tokenEnd)
    if (tokenStart === -1) {
      return false
    }
    tokenEnd = tokenStart + token.length
  }
  return true
}

function hasClaudeModelSwitchRejection(buffer: string): boolean {
  return compactTerminalText(buffer).includes('keptmodelas')
}

export function createClaudeModelSwitchConfirmationObserver(args: {
  expectedModelLabel: string | null
  subscribeToData: SubscribeToData
  submitConfirmation: () => boolean | void
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
    if (!confirmationSubmitted && hasClaudeModelSwitchConfirmation(observed)) {
      confirmationSubmitted = true
      try {
        // The picker already authorizes switching; this exact warning defaults to Yes and needs one Enter.
        const accepted = args.submitConfirmation() !== false
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
    const subscription = args.subscribeToData(observeData)
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
      // Start timeout at command delivery; SSH body/Enter latency must not consume the response window.
      if (settled) {
        return
      }
      scheduleTimeout()
    },
    dispose: () => finish('unknown')
  }
}
