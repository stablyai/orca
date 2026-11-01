import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-prompt-injection'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { resolvePasteReadySignal } from '../../../shared/draft-paste-ready-scanner'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '@/components/terminal-pane/terminal-bracketed-paste'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'
import { agentInputIsAdmitted, waitForAgentDraftInputReady } from './agent-draft-readiness'
import { showGeneratedInputNotice } from './launch-agent-paste-timeout-notice'
export {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'

// Bracketed paste keeps prompt insertion atomic; callers separately choose whether to submit with Enter.
export const BRACKETED_PASTE_BEGIN = BRACKETED_PASTE_START
export { BRACKETED_PASTE_END }
export const POST_PASTE_SUBMIT_DELAY_MS = AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS

// Budget PTY creation and composer readiness separately: slow spawn must neither consume composer grace nor delay failed-launch reporting (STA-3367).
const PTY_SPAWN_TIMEOUT_MS = 8000

/** Wait for safe agent input within one deadline, then paste; only submit appends Enter. Refusals retain the text, including uncertain partial writes. */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: (certainty?: 'not-sent' | 'unconfirmed') => void
  onUnconfirmedDelivery?: () => void
  /** The launch pane's PTY once its spawn says the agent started there; null when it didn't. */
  launchPty?: Promise<string | null>
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args

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
    agent,
    ...(args.launchPty ? { launchPty: args.launchPty } : {})
  })
  // Why: a pane that didn't start is the caller's own outcome to report, not a readiness timeout.
  if (args.launchPty && !(await args.launchPty)) {
    return false
  }
  const readiness = await readinessResult
  if (!readiness) {
    if (onTimeout) {
      onTimeout()
    } else {
      showGeneratedInputNotice({ agent, text: content })
    }
    return false
  }

  const { ptyId } = readiness
  if (!readiness.ready) {
    if (onTimeout) {
      onTimeout()
    } else {
      showGeneratedInputNotice({ agent, text: content })
    }
    return false
  }

  return await sendBracketedPasteToAgent({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    deadline: readiness.deadline,
    onTimeout
  })
}

export async function pasteDraftToAgentPtyWhenReady(args: {
  ptyId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: (certainty?: 'not-sent' | 'unconfirmed') => void
  onUnconfirmedDelivery?: () => void
  /** Last check after readiness; false retains the prompt for recovery. */
  beforePaste?: () => Promise<boolean>
}): Promise<boolean> {
  const { ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }

  const readySignal = resolvePasteReadySignal(agentConfig, submit === true)
  const budget = resolveDraftPasteReadyTimeoutMs(agent, timeoutMs)
  const deadline = Date.now() + budget
  const ready = await waitForAgentDraftInputReady(ptyId, budget, readySignal, agent)
  if (!ready) {
    if (onTimeout) {
      onTimeout()
    } else {
      showGeneratedInputNotice({ agent, text: content })
    }
    return false
  }
  if (args.beforePaste && !(await args.beforePaste())) {
    if (onTimeout) {
      onTimeout()
    } else {
      showGeneratedInputNotice({ agent, text: content })
    }
    return false
  }

  return await sendBracketedPasteToAgent({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    deadline,
    onTimeout
  })
}

export async function submitPromptToAgentPty(args: {
  tabId: string
  ptyId: string
  content: string
  agent?: TuiAgent
}): Promise<boolean> {
  return await pasteDraftToAgentPtyWhenReady({
    agent: args.agent,
    forcePaste: true,
    ptyId: args.ptyId,
    content: args.content,
    submit: true
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
}): Promise<boolean> {
  return await pasteDraftToAgentPtyWhenReady({ ...args, submit: true, forcePaste: true })
}

async function sendBracketedPasteToAgent(args: {
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  inputKind: TerminalInputKind
  deadline: number
  onTimeout?: (certainty?: 'not-sent' | 'unconfirmed') => void
}): Promise<boolean> {
  const { ptyId, content, submit, agent } = args
  const { inputKind } = args
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  let wrote = false
  const refuse = (): false => {
    const certainty = wrote ? 'unconfirmed' : 'not-sent'
    if (args.onTimeout) {
      args.onTimeout(certainty)
    } else {
      showGeneratedInputNotice({ agent, text: content, certainty })
    }
    return false
  }
  const admitted = async (): Promise<boolean> =>
    (await agentInputIsAdmitted(ptyId, agent)) && Date.now() < args.deadline
  try {
    // Keep paste, Enter and retry under one PTY lock or another paste could submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      const pasted = await sendAgentDraftPasteContentNow(
        ptyId,
        content,
        inputKind,
        async (data) => {
          if (!(await admitted())) {
            return false
          }
          wrote = true
          return sendRuntimePtyInputVerified(ptyId, data, inputKind)
        }
      )
      if (!pasted || !submit) {
        return pasted || refuse()
      }

      // Defer Enter to the next turn so Claude processes bracketed-paste termination before submission.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      if (!(await admitted())) {
        return refuse()
      }
      const submitted = await sendRuntimePtyInputVerified(ptyId, '\r', inputKind)

      if (submitRetryDelayMs !== undefined) {
        // Some composers render before accepting Enter; retry best-effort without downgrading the first submission verdict.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          if (await admitted()) {
            await sendRuntimePtyInputVerified(ptyId, '\r', inputKind)
          }
        } catch {
          // Why: a rejected retry leaves the first Enter's verdict untouched.
        }
      }

      return submitted || refuse()
    })
  } catch {
    return refuse()
  }
}

function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  launchPty?: Promise<string | null>
  agent?: TuiAgent
}): Promise<{ ptyId: string; ready: boolean; deadline: number } | null> {
  return new Promise((resolve) => {
    const readinessByPtyId = new Map<string, Promise<boolean>>()
    const deadlineByPtyId = new Map<string, number>()
    let settled = false
    let spawnTimer: number | null = null
    let unsubscribeStore: (() => void) | null = null
    const finish = (result: { ptyId: string; ready: boolean; deadline: number } | null): void => {
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
      deadlineByPtyId.set(ptyId, Date.now() + args.readinessTimeoutMs)
      const readiness = waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal,
        args.agent
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
      void watchPty(ptyId).then((ready) =>
        finish({ ptyId, ready, deadline: deadlineByPtyId.get(ptyId)! })
      )
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
