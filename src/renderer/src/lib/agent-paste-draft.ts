import type { TuiAgent } from '../../../shared/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  sanitizeTerminalPasteText
} from '@/components/terminal-pane/terminal-bracketed-paste'
import { waitForAgentReady } from './agent-ready-wait'
import { getSettingsForWorktreeRuntimeOwner } from './worktree-runtime-owner'
import type { GlobalSettings } from '../../../shared/types'
import { sendAgentDraftPasteContent } from './agent-draft-paste-content'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
export {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'

// Why: bracketed paste markers let modern TUIs (Claude Code / Codex / Pi /
// OpenCode / Gemini / cursor-agent / copilot) treat the inserted text as a
// single atomic paste instead of echoing character-by-character or triggering
// line-edit shortcuts. Callers choose whether to append Enter after the paste.
export const BRACKETED_PASTE_BEGIN = BRACKETED_PASTE_START
export { BRACKETED_PASTE_END }
export const POST_PASTE_SUBMIT_DELAY_MS = 50

export function sanitizeBracketedPasteContent(content: string): string {
  return sanitizeTerminalPasteText(content)
}

// Why: deterministic signal can fail in two ways: (1) the agent never
// emits DECSET 2004 (no shipped agent does this — guarded as a fallback),
// or (2) the launch fails outright. The hard timeout caps the wait so a
// stuck launch doesn't pin a Promise forever.
const READINESS_TIMEOUT_MS = 8000

export function getSettingsForAgentTabRuntimeOwner(
  tabId: string
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  const store = useAppStore.getState()
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree ?? {})) {
    if (tabs?.some((tab) => tab.id === tabId)) {
      // Why: legacy remote PTY ids may not embed their runtime owner. The tab's
      // worktree still identifies which host should receive readiness/send RPCs.
      return getSettingsForWorktreeRuntimeOwner(store, worktreeId)
    }
  }
  return store.settings
}

/**
 * Wait until the agent on `tabId` has rendered its input-accepting TUI,
 * then bracketed-paste `content` into its input buffer. By default the
 * draft stays editable; `submit: true` appends Enter after the paste.
 *
 * Returns true when the paste was issued, false on timeout or missing
 * PTY. `onTimeout` lets the caller surface a UI hint (e.g. toast) when
 * the agent doesn't reach a ready state inside `timeoutMs`.
 *
 * Readiness combines DECSET 2004 with one agent-specific follow-up signal:
 *   1. `\x1b[?2004h` (DECSET 2004 — bracketed-paste-enable) on the PTY
 *      output. This is the protocol-level "I accept bracketed paste"
 *      handshake.
 *   2. Either ≥`BRACKETED_PASTE_QUIET_MS` of silence after the last byte of
 *      the post-handshake render burst, or Codex's composer prompt glyph.
 */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args

  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  // Why: agents with a native draft prefill mechanism (flag or env var)
  // launch with the URL already in their input box. Pasting again would
  // duplicate it. Callers should not invoke this helper for those agents;
  // the early return guards against accidental double-injection if a stale
  // call slips through.
  if (!forcePaste && (agentConfig?.draftPromptFlag || agentConfig?.draftPromptEnvVar)) {
    return false
  }

  const budget = timeoutMs ?? READINESS_TIMEOUT_MS
  const readySignal = agentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const ptyId = await waitForPtyId(tabId, budget)
  if (!ptyId) {
    onTimeout?.()
    return false
  }

  const settings = getSettingsForAgentTabRuntimeOwner(tabId)
  const ready = await waitForAgentDraftInputReady(ptyId, budget, readySignal, settings)
  if (!ready) {
    // Why: fast-starting TUIs can emit the paste-ready escape sequence before
    // this sidecar subscription attaches. If process/title inspection says the
    // launched agent owns the PTY, fall back to a best-effort paste instead of
    // silently dropping generated prompts.
    const fallbackReady = agentConfig
      ? await waitForAgentReady(tabId, agentConfig.expectedProcess, { timeoutMs: 1000 })
      : { ready: false }
    if (!fallbackReady.ready) {
      onTimeout?.()
      return false
    }
  }

  return await sendBracketedPasteToAgent({
    settings,
    ptyId,
    content,
    submit: submit === true
  })
}

export async function pasteDraftToAgentPtyWhenReady(args: {
  tabId: string
  ptyId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
}): Promise<boolean> {
  const { tabId, ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  if (!forcePaste && (agentConfig?.draftPromptFlag || agentConfig?.draftPromptEnvVar)) {
    return false
  }

  const budget = timeoutMs ?? READINESS_TIMEOUT_MS
  const settings = getSettingsForAgentTabRuntimeOwner(tabId)
  const readySignal = agentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const ready = await waitForAgentDraftInputReady(ptyId, budget, readySignal, settings)
  if (!ready) {
    const fallbackReady = agentConfig
      ? await waitForExpectedAgentOnPty(ptyId, agentConfig.expectedProcess, 1000, settings)
      : false
    if (!fallbackReady) {
      onTimeout?.()
      return false
    }
  }

  return await sendBracketedPasteToAgent({
    settings,
    ptyId,
    content,
    submit: submit === true
  })
}

export async function submitPromptToAgentTab(args: {
  tabId: string
  content: string
  timeoutMs?: number
}): Promise<boolean> {
  const { tabId, content, timeoutMs } = args
  const ptyId = await waitForPtyId(tabId, timeoutMs ?? READINESS_TIMEOUT_MS)
  if (!ptyId) {
    return false
  }
  return await sendBracketedPasteToAgent({
    settings: getSettingsForAgentTabRuntimeOwner(tabId),
    ptyId,
    content,
    submit: true
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({ ptyId: args.ptyId, content: args.content, submit: true })
}

async function sendBracketedPasteToAgent(args: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  ptyId: string
  content: string
  submit: boolean
}): Promise<boolean> {
  const { settings = useAppStore.getState().settings, ptyId, content, submit } = args
  try {
    const pasted = await sendAgentDraftPasteContent(settings, ptyId, content)
    if (!pasted) {
      return false
    }
    if (!submit) {
      return true
    }

    // Why: Claude Code can leave a prompt as editable text when paste-end and
    // Enter arrive in the same PTY write. Split the submit into the next turn so
    // the TUI processes bracketed-paste termination before handling Enter.
    await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
    return await sendRuntimePtyInputVerified(settings, ptyId, '\r')
  } catch {
    return false
  }
}

/**
 * Why: activation creates the tab synchronously but the PTY spawn is
 * async. Poll the store until the primary PTY id appears or the budget
 * expires. Tight interval because the wait is normally <200ms — only the
 * first launch on a cold app reaches the tail of this.
 */
async function waitForPtyId(tabId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ptyId = useAppStore.getState().ptyIdsByTabId[tabId]?.[0]
    if (ptyId) {
      return ptyId
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
  }
  return null
}

async function waitForExpectedAgentOnPty(
  ptyId: string,
  expectedProcess: string,
  timeoutMs: number,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const process = await withDeadline(
        inspectRuntimeTerminalProcess(settings, ptyId),
        Math.max(0, deadline - Date.now())
      )
      if (!process) {
        return false
      }
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
    const delayMs = Math.min(120, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  return false
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}
