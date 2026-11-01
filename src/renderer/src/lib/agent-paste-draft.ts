import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { AGENT_PROMPT_POST_PASTE_SUBMIT_DELAY_MS } from '../../../shared/agent-prompt-injection'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { resolvePasteReadySignal } from '../../../shared/draft-paste-ready-scanner'
import {
  resolveTerminalCtrlEnterInput,
  TERMINAL_ENTER_INPUT
} from '../../../shared/terminal-ctrl-enter-input'
import { resolveAgentPostPasteSubmitInput } from '../../../shared/tui-agent-post-paste-submit'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '@/components/terminal-pane/terminal-bracketed-paste'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { getPtyKittyKeyboardFlags } from '@/components/terminal-pane/terminal-pty-kitty-keyboard-flags'
import { waitForAgentReady } from './agent-ready-wait'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import {
  waitForAgentDraftInputReadyOnTab,
  waitForExpectedAgentOnPty
} from './agent-draft-pty-readiness'
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

  return await sendBracketedPasteToAgent({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch'
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
  agent?: TuiAgent
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({
    ptyId: args.ptyId,
    content: args.content,
    submit: true,
    agent: args.agent,
    inputKind: 'driving'
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
  agent?: TuiAgent
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({ ...args, submit: true, inputKind: 'driving' })
}

async function sendBracketedPasteToAgent(args: {
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  inputKind: TerminalInputKind
}): Promise<boolean> {
  const { ptyId, content, submit, agent } = args
  const { inputKind } = args
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  const submitInput = resolvePostPasteSubmitSequence(
    agent,
    useAppStore.getState().settings?.agentPostPasteSubmitInputs,
    ptyId
  )
  try {
    // Keep paste, Enter and retry under one PTY lock or another paste could submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      const pasted = await sendAgentDraftPasteContentNow(ptyId, content, inputKind)
      if (!pasted || !submit) {
        return pasted
      }

      // Defer Enter to the next turn so Claude processes bracketed-paste termination before submission.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      const submitted = await sendRuntimePtyInputVerified(ptyId, submitInput, inputKind)

      if (submitRetryDelayMs !== undefined) {
        // Some composers render before accepting Enter; retry best-effort without downgrading the first submission verdict.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          await sendRuntimePtyInputVerified(ptyId, submitInput, inputKind)
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

function resolvePostPasteSubmitSequence(
  agent: TuiAgent | undefined,
  configuredInputs: GlobalSettings['agentPostPasteSubmitInputs'] | undefined,
  ptyId: string
): string {
  const configuredInput = resolveAgentPostPasteSubmitInput(agent, configuredInputs)
  return configuredInput === 'ctrl-enter'
    ? resolveTerminalCtrlEnterInput(getPtyKittyKeyboardFlags(ptyId))
    : TERMINAL_ENTER_INPUT
}
