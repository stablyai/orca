import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal/input/terminal-input-kind'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../shared/generated-agent-input-readiness'
import type { GeneratedInputOutcome } from '../../../shared/generated-terminal-input'
import { sendGeneratedTerminalInput } from '@/runtime/generated-terminal-input-client'
import {
  generatedInputAttempt,
  type GeneratedInputAttempt
} from '@/runtime/generated-input-attempt'
import { useAppStore } from '@/store'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'
import { createLegacyGeneratedInputSource } from './agent-draft-readiness'
import { runGeneratedInputOperation } from '../../../shared/generated-input-operation'
import { GeneratedInputLifetime } from '../../../shared/generated-input-lifetime'
import { noticeGeneratedInputFailure } from './agent-session/launch/prompt/launch-agent-paste-timeout-notice'
import {
  acceptGeneratedInput,
  deliverKeepingNotice,
  keepGeneratedInputNotice,
  type GeneratedSend
} from './generated-paste-notice'
import { settleGeneratedInputNotice } from '@/runtime/generated-input-notice-registration'
export {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'

// Bracketed paste keeps prompt insertion atomic; callers separately choose whether to submit with Enter.

// Budget PTY creation and composer readiness separately: slow spawn must neither consume composer grace nor delay failed-launch reporting (STA-3367).
const PTY_SPAWN_TIMEOUT_MS = 8000

/** A refused or uncertain paste. `retained`: the host keeps its notice, so none is shown here. */
export type GeneratedPasteRefusal = (
  certainty?: 'not-sent' | 'unconfirmed',
  retained?: boolean,
  /** The accepted request this refusal ends, for the caller's own notice of it. */
  operationId?: string
) => void

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
  /** The request's operation id when an earlier attempt already accepted it (the allowed
   *  fresh-session fallback of a reused automation session). */
  operationId?: string
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  // Native-prefill agents already received the draft; skip redundant paste unless explicitly forced.
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }
  const deadline = Date.now() + (timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS)
  // The text is this window's runtime's obligation before the wait for a terminal.
  const operationId = acceptGeneratedInput({
    text: content,
    agent,
    submit: submit === true,
    ...(args.operationId ? { operationId: args.operationId } : {})
  })
  const report = { agent, content, submit: submit === true, onTimeout, operationId }
  const ptyId = await waitForTabPty(tabId, args.launchPty)
  // Why: a pane that didn't start is the caller's own outcome to report, not a readiness timeout.
  if (args.launchPty && !ptyId) {
    settleGeneratedInputNotice(operationId)
    return false
  }
  if (!ptyId) {
    const kept = await keepGeneratedInputNotice({
      agent,
      text: content,
      ...(submit === true ? {} : { submitted: false }),
      operationId
    })
    return reportGeneratedPaste('not-sent', { ...report, retained: kept })
  }
  let retained = false
  const outcome = await deliverGeneratedPaste({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    intent: 'startup',
    deadline,
    operationId,
    onNoticeRetained: () => (retained = true)
  })
  return reportGeneratedPaste(outcome, { ...report, retained })
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
  /** Default startup: the agent was just launched. A running agent refuses only on blocking evidence. */
  intent?: 'startup' | 'running'
  /** Every frame needs this agent (or a wrapper with a child) in front. */
  requireConsumer?: boolean
  /** The id its text was already accepted under. */
  operationId?: string
}): Promise<boolean> {
  const { ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout } = args
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }
  // Accepted once, here: every outcome, refusal and late answer below names this one request.
  const operationId = acceptGeneratedInput({
    text: content,
    agent,
    submit: submit === true,
    ptyId,
    ...(args.operationId ? { operationId: args.operationId } : {})
  })
  let retained = false
  const outcome = await deliverGeneratedPaste({
    ptyId,
    content,
    submit: submit === true,
    agent,
    inputKind: 'launch',
    intent: args.intent ?? 'startup',
    deadline: Date.now() + (timeoutMs ?? GENERATED_AGENT_INPUT_TIMEOUT_MS),
    ...(args.requireConsumer ? { requireConsumer: true } : {}),
    operationId,
    onNoticeRetained: () => (retained = true)
  })
  const report = { agent, content, submit: submit === true, onTimeout, operationId, retained }
  return reportGeneratedPaste(outcome, report)
}

/** A reused automation session: the typed outcome decides whether a fresh session may start. */
export async function submitPromptToAgentPty(args: {
  tabId: string
  ptyId: string
  content: string
  agent?: TuiAgent
  /** The automation request's one id, carried into its allowed fresh-session fallback. */
  operationId?: string
}): Promise<GeneratedInputOutcome> {
  return deliverGeneratedPaste({
    ptyId: args.ptyId,
    content: args.content,
    submit: true,
    agent: args.agent,
    inputKind: 'driving',
    intent: 'running',
    deadline: Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS,
    ...(args.operationId ? { operationId: args.operationId } : {})
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
  args: {
    agent?: TuiAgent
    content: string
    submit: boolean
    onTimeout?: GeneratedPasteRefusal
    retained?: boolean
    operationId: string
  }
): boolean {
  if (outcome === 'delivered' || outcome === 'staged') {
    return true
  }
  const certainty = outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent'
  if (args.onTimeout) {
    args.onTimeout(certainty, args.retained === true, args.operationId)
  } else if (!args.retained) {
    // The same accepted request, with the intent it was accepted under.
    noticeGeneratedInputFailure({
      agent: args.agent,
      text: args.content,
      certainty,
      ...(args.submit ? {} : { submitted: false }),
      operationId: args.operationId
    })
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
  /** Ends the request (a person took the terminal over); a lost answer reads as unconfirmed. */
  signal?: AbortSignal
  /** Every frame needs the expected agent (or a wrapper with a child) in front. */
  requireConsumer?: boolean
  /** The caller reports failures: called when a runtime owner kept the notice instead, so the
   *  caller shows none of its own. */
  onNoticeRetained?: () => void
  /** The id this request's text was accepted under; one is made when absent. */
  operationId?: string
  /** The accepted request this delivery continues (its end and selected route), when a caller
   *  already began one; else one begins here from `deadline`. */
  attempt?: GeneratedInputAttempt
}

/** A capable host admits and writes in one transaction; only an older host gets the client adapter.
 *  A caller that reports failures has its notice kept by one runtime owner (see deliverKeepingNotice). */
export async function deliverGeneratedPaste(paste: GeneratedPaste): Promise<GeneratedInputOutcome> {
  const attempt = paste.attempt ?? generatedInputAttempt(paste.deadline)
  const send: GeneratedSend = async (extra, onReply, onRoute) => {
    const hosted = await sendGeneratedTerminalInput(
      paste.ptyId,
      {
        text: paste.content,
        submit: paste.submit,
        agent: paste.agent ?? null,
        inputKind: paste.inputKind,
        intent: paste.intent,
        timeoutMs: Math.max(0, paste.deadline - Date.now()),
        ...(paste.requireConsumer ? { requireConsumer: true } : {}),
        ...extra
      },
      paste.signal,
      onReply,
      onRoute,
      attempt
    )
    return hosted !== null
      ? { outcome: hosted, hosted: true }
      : { outcome: await pasteThroughLegacyHost(paste, extra.operationId, attempt), hosted: false }
  }
  if (!paste.onNoticeRetained) {
    // A caller with its own failure surface still carries the request's identity.
    return (
      await send(
        paste.operationId ? { operationId: paste.operationId } : {},
        () => {},
        () => {}
      )
    ).outcome
  }
  const { outcome, kept } = await deliverKeepingNotice(paste, send)
  if (kept) {
    paste.onNoticeRetained()
  }
  return outcome
}

/** An older host: the same operation, with this client's evidence and the existing input route. */
async function pasteThroughLegacyHost(
  paste: GeneratedPaste,
  operationId: string | undefined,
  attempt: GeneratedInputAttempt
): Promise<GeneratedInputOutcome> {
  const result = await runGeneratedInputOperation(
    createLegacyGeneratedInputSource({
      ptyId: paste.ptyId,
      content: paste.content,
      agent: paste.agent,
      inputKind: paste.inputKind,
      // The runtime that writes each frame settles the accepted request; this window may be gone.
      ...(operationId ? { operationId } : {}),
      // The same end and selected route as the hosted attempt that found this host older.
      attempt,
      ...(paste.signal ? { signal: paste.signal } : {})
    }),
    {
      agent: paste.agent ?? null,
      submit: paste.submit,
      intent: paste.intent,
      requireConsumer: paste.requireConsumer,
      // The request's lifetime starts at the producer's call.
      lifetime: new GeneratedInputLifetime({
        deadline: attempt.end,
        signal: paste.signal,
        submit: paste.submit
      })
    }
  )
  return result.outcome
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
