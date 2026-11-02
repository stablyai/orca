import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-prompt-injection'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../shared/generated-agent-input-readiness'
import type { GeneratedInputOutcome } from '../../../shared/generated-terminal-input'
import { sendGeneratedTerminalInput } from '@/runtime/generated-terminal-input-client'
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
import {
  agentInputIsAdmitted,
  forgetLegacyTail,
  waitForAgentDraftInputReady
} from './agent-draft-readiness'
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

type GeneratedPasteRefusal = (certainty?: 'not-sent' | 'unconfirmed') => void

/** Resolve the tab's PTY, then hand the text to that PTY's host; only submit appends Enter. Refusals
 *  retain the text, including uncertain partial writes. */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: GeneratedPasteRefusal
  onUnconfirmedDelivery?: () => void
  /** The launch pane's PTY once its spawn says the agent started there; null when it didn't. */
  launchPty?: Promise<string | null>
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  // Native-prefill agents already received the draft; skip redundant paste unless explicitly forced.
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }
  const deadline = Date.now() + (timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS)
  const ptyId = await waitForTabPty(tabId, args.launchPty)
  // Why: a pane that didn't start is the caller's own outcome to report, not a readiness timeout.
  if (args.launchPty && !ptyId) {
    return false
  }
  if (!ptyId) {
    return reportGeneratedPaste('not-sent', { agent, content, onTimeout })
  }
  const outcome = await deliverGeneratedPaste({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    intent: 'startup',
    deadline
  })
  return reportGeneratedPaste(outcome, { agent, content, onTimeout })
}

export async function pasteDraftToAgentPtyWhenReady(args: {
  ptyId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: GeneratedPasteRefusal
  onUnconfirmedDelivery?: () => void
  /** The legacy adapter's last check after readiness; false retains the prompt for recovery. */
  beforePaste?: () => Promise<boolean>
  /** Default startup: the agent was just launched. A running agent refuses only on blocking evidence. */
  intent?: 'startup' | 'running'
}): Promise<boolean> {
  const { ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }
  const outcome = await deliverGeneratedPaste({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    intent: args.intent ?? 'startup',
    deadline: Date.now() + (timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS),
    ...(args.beforePaste ? { beforePaste: args.beforePaste } : {})
  })
  return reportGeneratedPaste(outcome, { agent, content, onTimeout })
}

/** A reused automation session: the typed outcome decides whether a fresh session may start. */
export async function submitPromptToAgentPty(args: {
  tabId: string
  ptyId: string
  content: string
  agent?: TuiAgent
}): Promise<GeneratedInputOutcome> {
  return deliverGeneratedPaste({
    ptyId: args.ptyId,
    content: args.content,
    submit: true,
    agent: args.agent,
    inputKind: 'driving',
    intent: 'running',
    deadline: Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
}): Promise<boolean> {
  return await pasteDraftToAgentPtyWhenReady({
    ...args,
    submit: true,
    forcePaste: true,
    intent: 'running'
  })
}

function reportGeneratedPaste(
  outcome: GeneratedInputOutcome,
  args: { agent?: TuiAgent; content: string; onTimeout?: GeneratedPasteRefusal }
): boolean {
  if (outcome === 'delivered' || outcome === 'staged') {
    return true
  }
  const certainty = outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
  if (args.onTimeout) {
    args.onTimeout(certainty)
  } else {
    showGeneratedInputNotice({ agent: args.agent, text: args.content, certainty })
  }
  return false
}

export type GeneratedPaste = {
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  inputKind: Extract<TerminalInputKind, 'launch' | 'driving'>
  /** startup waits for positive readiness; running (main's direct sends) refuses only on blocking evidence. */
  intent: 'startup' | 'running'
  deadline: number
  beforePaste?: () => Promise<boolean>
}

/** A capable host admits and writes in one transaction; only an older host gets the client adapter. */
export async function deliverGeneratedPaste(paste: GeneratedPaste): Promise<GeneratedInputOutcome> {
  const hosted = await sendGeneratedTerminalInput(paste.ptyId, {
    text: paste.content,
    submit: paste.submit,
    agent: paste.agent ?? null,
    inputKind: paste.inputKind,
    intent: paste.intent,
    timeoutMs: Math.max(0, paste.deadline - Date.now())
  })
  return hosted ?? (await pasteThroughLegacyHost(paste))
}

/** Legacy adapter: the host's rule on this client's evidence, rechecked before every frame. */
async function pasteThroughLegacyHost(paste: GeneratedPaste): Promise<GeneratedInputOutcome> {
  const { ptyId, submit, agent, deadline } = paste
  const readySignal = resolvePasteReadySignal(agent ? TUI_AGENT_CONFIG[agent] : null, submit)
  const remaining = Math.max(0, deadline - Date.now())
  try {
    return await pasteAfterLegacyReadiness(paste, readySignal, remaining)
  } finally {
    forgetLegacyTail(ptyId)
  }
}

async function pasteAfterLegacyReadiness(
  paste: GeneratedPaste,
  readySignal: ReturnType<typeof resolvePasteReadySignal>,
  remaining: number
): Promise<GeneratedInputOutcome> {
  const { ptyId, content, submit, agent, inputKind, deadline } = paste
  const ready = await waitForAgentDraftInputReady(
    ptyId,
    remaining,
    readySignal,
    agent,
    undefined,
    '',
    paste.intent
  )
  if (!ready) {
    return 'not-sent'
  }
  if (paste.beforePaste && !(await paste.beforePaste())) {
    return 'not-sent'
  }
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  let wrote = false
  const admitted = async (typedText?: string): Promise<boolean> =>
    (await agentInputIsAdmitted(ptyId, agent, false, typedText)) && Date.now() < deadline
  try {
    // Keep paste, Enter and retry under one PTY lock or another paste could submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      const pasted = await sendAgentDraftPasteContentNow(
        ptyId,
        content,
        inputKind,
        async (data) => {
          if (!(await admitted(wrote ? content : undefined))) {
            return false
          }
          wrote = true
          return sendRuntimePtyInputVerified(ptyId, data, inputKind)
        }
      )
      if (!pasted) {
        return wrote ? 'unconfirmed' : 'not-sent'
      }
      if (!submit) {
        return 'staged'
      }
      // Defer Enter to the next turn so Claude processes bracketed-paste termination before submission.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      if (
        !(await admitted(content)) ||
        !(await sendRuntimePtyInputVerified(ptyId, '\r', inputKind))
      ) {
        return 'unconfirmed'
      }
      if (submitRetryDelayMs !== undefined) {
        // Some composers render before accepting Enter; retry best-effort without downgrading the first submission verdict.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          if (await admitted(content)) {
            await sendRuntimePtyInputVerified(ptyId, '\r', inputKind)
          }
        } catch {
          // Why: a rejected retry leaves the first Enter's verdict untouched.
        }
      }
      return 'delivered'
    })
  } catch {
    return wrote ? 'unconfirmed' : 'not-sent'
  }
}

/** The tab's PTY once it binds: the launch pane's own when given, else the first within spawn time. */
function waitForTabPty(tabId: string, launchPty?: Promise<string | null>): Promise<string | null> {
  if (launchPty) {
    return launchPty
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribeStore: (() => void) | null = null
    const finish = (ptyId: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(spawnTimer)
      unsubscribeStore?.()
      resolve(ptyId)
    }
    const spawnTimer = window.setTimeout(() => finish(null), PTY_SPAWN_TIMEOUT_MS)
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const ptyId = state.ptyIdsByTabId[tabId]?.[0]
      if (ptyId) {
        finish(ptyId)
      }
    }
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
  })
}
