import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal/input/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/agent-launch/catalog/tui-agent-config'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-launch/startup/agent-prompt-injection'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { resolvePasteReadySignal } from '../../../shared/draft-paste-ready-scanner'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import '@/components/terminal-pane/terminal-bracketed-paste'
import { BRACKETED_PASTE_END } from '../../../shared/terminal/input/terminal-bracketed-paste-text'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { waitForAgentReady } from './agent-ready-wait'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'
import { waitForAgentDraftInputReady, waitForExpectedAgentOnPty } from './agent-draft-readiness'
export {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'

// Bracketed paste keeps prompt insertion atomic; callers separately choose whether to submit with Enter.

const POST_PASTE_SUBMIT_DELAY_MS = AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS

// Budget PTY creation and composer readiness separately: slow spawn must neither consume composer grace nor delay failed-launch reporting (STA-3367).
const PTY_SPAWN_TIMEOUT_MS = 8000

/** Paste after DECSET 2004 plus the agent’s composer signal/quiet window. Drafts stay editable unless submit appends Enter; false means no paste. timeoutMs controls readiness only, and onTimeout reports missing readiness. */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
  onUnconfirmedDelivery?: () => void
  /** The launch pane's PTY once its spawn says the agent started there; null when it didn't. */
  launchPty?: Promise<string | null>
  beforePaste?: () => boolean
  claimFirstWrite?: () => boolean
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout, onUnconfirmedDelivery } =
    args

  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  // Native-prefill agents already received the draft; skip redundant paste unless explicitly forced.
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }

  const readySignal = resolvePasteReadySignal(agentConfig, submit === true)
  const readinessTimeoutMs = resolveDraftPasteReadyTimeoutMs(agent, timeoutMs)
  const readinessResult = waitForAgentDraftInputReadyOnTab({
    tabId,
    spawnTimeoutMs: PTY_SPAWN_TIMEOUT_MS,
    readinessTimeoutMs,
    readySignal,
    ...(args.launchPty ? { launchPty: args.launchPty } : {})
  })
  // Why: a pane that didn't start is the caller's own outcome to report, not a readiness timeout.
  if (args.launchPty && !(await args.launchPty)) {
    return false
  }
  const readiness = await readinessResult
  if (!readiness) {
    onTimeout?.()
    return false
  }

  const { ptyId } = readiness
  if (!readiness.ready) {
    // Early readiness bytes may precede this observer; process/title ownership allows best-effort fallback, but Codex may still own a startup dialog or discard provisional input.
    const fallbackReady =
      agentConfig && agent !== 'codex'
        ? await waitForAgentReady(tabId, agentConfig.expectedProcess, { timeoutMs: 1000 })
        : { ready: false }
    if (!fallbackReady.ready) {
      onTimeout?.()
      return false
    }
    // Process existence does not prove composer readiness; report blind writes separately (#22479).
    onUnconfirmedDelivery?.()
  }

  if (args.beforePaste && !args.beforePaste()) {
    return false
  }
  return await sendBracketedPasteToAgent({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    beforePaste: args.beforePaste,
    claimFirstWrite: args.claimFirstWrite
  })
}

export async function pasteDraftToAgentPtyWhenReady(args: {
  ptyId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
  onUnconfirmedDelivery?: () => void
  /** Last check after readiness; false drops the paste. */
  beforePaste?: () => Promise<boolean>
}): Promise<boolean> {
  const { ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout, onUnconfirmedDelivery } =
    args
  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }

  const readySignal = resolvePasteReadySignal(agentConfig, submit === true)
  const budget = resolveDraftPasteReadyTimeoutMs(agent, timeoutMs)
  const ready = await waitForAgentDraftInputReady(ptyId, budget, readySignal)
  if (!ready) {
    const fallbackReady =
      agentConfig && agent !== 'codex'
        ? await waitForExpectedAgentOnPty(ptyId, agentConfig.expectedProcess, 1000)
        : false
    if (!fallbackReady) {
      onTimeout?.()
      return false
    }
    onUnconfirmedDelivery?.()
  }
  if (args.beforePaste && !(await args.beforePaste())) {
    return false
  }

  return await sendBracketedPasteToAgent({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch'
  })
}

export async function submitPromptToAgentPty(args: {
  tabId: string
  ptyId: string
  content: string
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({
    ptyId: args.ptyId,
    content: args.content,
    submit: true,
    inputKind: 'driving'
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({ ...args, submit: true, inputKind: 'driving' })
}

async function sendBracketedPasteToAgent(args: {
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  inputKind: TerminalInputKind
  beforePaste?: () => boolean
  claimFirstWrite?: () => boolean
}): Promise<boolean> {
  const { ptyId, content, submit, agent } = args
  const { inputKind } = args
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  try {
    // Keep paste, Enter and retry under one PTY lock or another paste could submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      if (args.beforePaste && !args.beforePaste()) {
        return false
      }
      let claimed = false
      const pasted = await sendAgentDraftPasteContentNow(
        ptyId,
        content,
        inputKind,
        args.claimFirstWrite || args.beforePaste
          ? (data) => {
              // Close an open paste after revocation, but never send more content.
              if (data !== BRACKETED_PASTE_END && args.beforePaste && !args.beforePaste()) {
                return false
              }
              if (!claimed) {
                if (args.claimFirstWrite && !args.claimFirstWrite()) {
                  return false
                }
                claimed = true
              }
              return sendRuntimePtyInputVerified(ptyId, data, inputKind)
            }
          : undefined
      )
      if (!pasted || !submit) {
        return pasted
      }

      // Defer Enter to the next turn so Claude processes bracketed-paste termination before submission.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      if (args.beforePaste && !args.beforePaste()) {
        return false
      }
      const submitted = await sendRuntimePtyInputVerified(ptyId, '\r', inputKind)

      if (submitRetryDelayMs !== undefined) {
        // Some composers render before accepting Enter; retry best-effort without downgrading the first submission verdict.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          if (!args.beforePaste || args.beforePaste()) {
            await sendRuntimePtyInputVerified(ptyId, '\r', inputKind)
          }
        } catch {
          // Why: a rejected retry leaves the first Enter's verdict untouched.
        }
      }

      return submitted
    })
  } catch {
    return false
  }
}

function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  launchPty?: Promise<string | null>
}): Promise<{ ptyId: string; ready: boolean } | null> {
  return new Promise((resolve) => {
    const readinessByPtyId = new Map<string, Promise<boolean>>()
    let settled = false
    let spawnTimer: number | null = null
    let unsubscribeStore: (() => void) | null = null
    const finish = (result: { ptyId: string; ready: boolean } | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      resolve(result)
    }
    const watchPty = (ptyId: string): Promise<boolean> => {
      const existing = readinessByPtyId.get(ptyId)
      if (existing) {
        return existing
      }
      const readiness = waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal
      )
      readinessByPtyId.set(ptyId, readiness)
      return readiness
    }
    const deliverPty = (ptyId: string): void => {
      if (settled) {
        return
      }
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      void watchPty(ptyId).then((ready) => finish({ ptyId, ready }))
    }
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const ptyIds = state.ptyIdsByTabId[args.tabId] ?? []
      if (args.launchPty) {
        // Each pane's readiness attaches before its primary handler drains startup bytes.
        for (const ptyId of ptyIds) {
          watchPty(ptyId)
        }
      } else if (ptyIds[0]) {
        deliverPty(ptyIds[0])
      }
    }
    if (args.launchPty) {
      void args.launchPty.then((ptyId) => (ptyId ? deliverPty(ptyId) : finish(null)))
    } else {
      spawnTimer = window.setTimeout(() => finish(null), args.spawnTimeoutMs)
    }
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
  })
}
