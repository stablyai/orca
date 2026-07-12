import { useAppStore } from '@/store'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { TuiAgent } from '../../../shared/types'

// Why: hook receipts prove the agent accepted the prompt as a real turn —
// codex trust/update screens and claude login screens swallow pastes without
// ever firing UserPromptSubmit, and both agents' Orca-managed hooks emit it
// on genuine submission (issue #7466). Strict verification applies only to
// agents whose managed hook service is installed; anything else keeps the
// optimistic legacy behavior rather than false-failing on absent plumbing.
const RECEIPT_ELIGIBLE_AGENTS = new Set<TuiAgent>(['claude', 'codex'])

// Why: the receipt normally lands ~1-2s after submit, but a paste buffered
// during agent cold boot is only submitted once the TUI drains stdin — the
// window must absorb that boot, and a slow verdict is safe because failure
// only re-opens the recovery dialog.
export const PROMPT_RECEIPT_TIMEOUT_MS = 15_000

// Why: receivedAt is stamped by the main process while `since` is renderer
// time; a small slack absorbs cross-process clock skew without admitting
// receipts from a previous turn.
const RECEIPT_CLOCK_SLACK_MS = 2_000

// Why: "installed" is not proof the channel speaks — codex silently drops
// hooks.json configs it does not trust while the install check still passes
// (live-reproduced: fresh managed home → zero hook events → every launch
// would false-fail). Require at least one observed hook status from the
// agent this session before trusting its receipts; until then the launch
// keeps the optimistic legacy verdict, which is today's behavior.
function hasObservedHookStatusForAgent(agent: TuiAgent): boolean {
  const statuses = useAppStore.getState().agentStatusByPaneKey ?? {}
  for (const status of Object.values(statuses)) {
    if (status?.agentType === agent) {
      return true
    }
  }
  return false
}

export async function isPromptReceiptEligible(agent: TuiAgent | undefined): Promise<boolean> {
  if (!agent || !RECEIPT_ELIGIBLE_AGENTS.has(agent)) {
    return false
  }
  if (!hasObservedHookStatusForAgent(agent)) {
    return false
  }
  try {
    const status =
      agent === 'claude'
        ? await window.api.agentHooks.claudeStatus()
        : await window.api.agentHooks.codexStatus()
    return status.state === 'installed'
  } catch {
    return false
  }
}

export type PromptSubmitReceiptWatch = {
  /** Resolves true when a UserPromptSubmit receipt for the tab arrives; false on timeout/cancel. */
  result: Promise<boolean>
  /**
   * Arm the timeout countdown. Call AFTER the paste+Enter is issued so the full
   * window covers the post-submit hook round-trip, not the readiness wait that
   * precedes the paste (which can run many seconds on a cold SSH boot) —
   * otherwise the window expires before the prompt is even submitted (issue
   * #7466). Idempotent and a no-op once the watch has settled.
   */
  startTimer: () => void
  cancel: () => void
}

/**
 * Watch the agent-status IPC stream for a UserPromptSubmit receipt bound to
 * `tabId`. Subscribe BEFORE submitting so a fast receipt cannot slip past the
 * subscription, then call `startTimer()` once the paste is in to arm the
 * timeout. Remote (SSH) launches arrive through the same channel via the
 * agent-hook relay, so no transport split is needed.
 */
export function watchForPromptSubmitReceipt(args: {
  tabId: string
  agent: TuiAgent
  since: number
  timeoutMs?: number
}): PromptSubmitReceiptWatch {
  const { tabId, agent, since, timeoutMs } = args
  let cancel: () => void = () => {}
  let startTimer: () => void = () => {}
  const result = new Promise<boolean>((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: number | null = null

    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        window.clearTimeout(timer)
      }
      unsubscribe?.()
      resolve(value)
    }
    cancel = () => finish(false)
    startTimer = () => {
      if (settled || timer !== null) {
        return
      }
      timer = window.setTimeout(() => finish(false), timeoutMs ?? PROMPT_RECEIPT_TIMEOUT_MS)
    }

    unsubscribe = window.api.agentStatus.onSet((data: AgentStatusIpcPayload) => {
      if (data.tabId !== tabId) {
        return
      }
      if (data.hookEventName !== 'UserPromptSubmit' || data.hasExplicitPrompt !== true) {
        return
      }
      if (data.agentType !== undefined && data.agentType !== agent) {
        return
      }
      if (data.receivedAt < since - RECEIPT_CLOCK_SLACK_MS) {
        return
      }
      finish(true)
    })
  })
  return { result, startTimer, cancel }
}
