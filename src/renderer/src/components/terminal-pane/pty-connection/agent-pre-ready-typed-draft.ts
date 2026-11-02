// Pre-bind keys would prefix the launch command; draft until agent readiness and recover if the user starts driving the live screen.

import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../../shared/generated-agent-input-readiness'
import { deliverGeneratedPaste } from '@/lib/agent-paste-draft'
import { waitForAgentDraftInputReady } from '@/lib/agent-draft-readiness'
import { TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { PTY_PRECONNECT_INPUT_MAX_CODE_UNITS } from '../pty-preconnect-input-buffer'
import { findColdRestoreResumeSource } from './cold-restore-resume-startup'
import { paneHasStartupWork } from './pane-transport-options'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const BACKSPACE = '\x7f'
const CTRL_H = '\b'

/** Ignore control/escape input so drafts cannot submit; Backspace deletes and pasted line breaks become spaces. */
export function appendTypedDraftText(draft: string, data: string, maxCodeUnits: number): string {
  if (data.startsWith('\x1b')) {
    return draft
  }
  const isPasteChunk = data.length > 1
  let next = draft
  let pendingSpace = false
  for (const char of data) {
    if (char === BACKSPACE || char === CTRL_H) {
      next = Array.from(next).slice(0, -1).join('')
      continue
    }
    if (isPasteChunk && (char === '\r' || char === '\n')) {
      pendingSpace = next !== '' && !/\s$/.test(next)
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue
    }
    if (pendingSpace && next.length < maxCodeUnits) {
      next += ' '
    }
    pendingSpace = false
    if (next.length + char.length > maxCodeUnits) {
      break
    }
    next += char
  }
  return next
}

type DraftPhase = 'capturing' | 'delivering' | 'closed'

export function installAgentPreReadyTypedDraft(session: ConnectPanePtySession): void {
  let phase: DraftPhase = 'capturing'
  let draft = ''
  let wrote = false
  let observation: AbortController | null = null
  let liveInputSinceBind = false
  let agent: TuiAgent | null | undefined

  const resolveAgent = (): TuiAgent | null => {
    if (agent === undefined) {
      const state = useAppStore.getState()
      // Why not paired panes: their transport already holds and delivers type-ahead itself.
      agent =
        !session.runtimeEnvironmentId &&
        !session.transportOptions?.bufferInputUntilConnect &&
        paneHasStartupWork(session)
          ? ((session.paneStartup
              ? (session.startupDraftAgent ?? session.resolveExpectedLaunchTuiAgent())
              : null) ??
            findColdRestoreResumeSource(session, state)?.agent ??
            null)
          : null
    }
    return agent ?? null
  }

  // Why seeded: a deferred split with agent startup used to flush handed-off keys at bind.
  for (const entry of session.deps.preconnectInput ?? []) {
    if (entry.inputKind === 'driving' && resolveAgent()) {
      draft = appendTypedDraftText(draft, entry.data, PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
    }
  }

  session.captureAgentPreReadyInput = (data: string, wasUserInput: boolean): boolean => {
    if (!resolveAgent()) {
      return false
    }
    if (session.transport.getPtyId() !== null) {
      // Why always live: a trust or permission prompt on screen must take the user's keys.
      liveInputSinceBind ||= wasUserInput
      if (phase === 'capturing') {
        // Capture only before first bind; later unbinds leave input holding/delivery to the host.
        phase = draft === '' ? 'closed' : 'delivering'
      }
      return false
    }
    if (phase !== 'capturing') {
      return false
    }
    if (wasUserInput) {
      draft = appendTypedDraftText(draft, data, PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
      // Why: a connect hung past its grace still needs typing to arm recovery; its guards stay quiet before then.
      session.requestRecoveryForUndeliverableInput()
    }
    // Pre-bind focus reports have no terminal to reach.
    return true
  }

  const recoverDraft = (draftAgent: TuiAgent): void => {
    const retained = draft !== ''
    const content = draft
    draft = ''
    phase = 'closed'
    if (retained) {
      createPasteReadinessTimeoutNotice({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        agent: draftAgent,
        submitted: false,
        content
      }).onTimeout(wrote ? 'unconfirmed' : 'not-sent')
    }
  }

  /** The pane's readiness is only when to offer the keys; the PTY's host still admits and writes. */
  const pasteDraft = (ptyId: string, draftAgent: TuiAgent, deadline: number): void => {
    if (session.disposed || session.transport.getPtyId() !== ptyId) {
      recoverDraft(draftAgent)
      return
    }
    const status = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.state
    // The user is already driving the screen, or a prompt is waiting on an answer.
    if (liveInputSinceBind || status === 'blocked' || status === 'waiting') {
      recoverDraft(draftAgent)
      return
    }
    void deliverGeneratedPaste({
      ptyId,
      content: draft,
      submit: false,
      agent: draftAgent,
      inputKind: 'driving',
      intent: 'startup',
      // The same deadline the readiness observation spent: no second, fresh budget.
      deadline
    }).then((outcome) => {
      if (outcome === 'staged' || outcome === 'delivered') {
        draft = ''
        phase = 'closed'
        return
      }
      wrote = outcome === 'unconfirmed'
      recoverDraft(draftAgent)
    })
  }

  session.onAgentPreReadyDraftPtyBound = (ptyId: string, freshSpawn: boolean): void => {
    if (phase !== 'capturing') {
      return
    }
    const draftAgent = resolveAgent()
    if (!draftAgent || draft === '') {
      draft = ''
      phase = 'closed'
      return
    }
    phase = 'delivering'
    if (session.ownsStartupDraftPaste && !session.startupDraftPasteAttempted) {
      session.startupDraftPrompt = joinDraftText(session.startupDraftPrompt, draft)
      draft = ''
      phase = 'closed'
      return
    }
    if (!freshSpawn) {
      // An attached pane may still be at the shell; pasting now would prefix its pending launch command.
      recoverDraft(draftAgent)
      return
    }
    liveInputSinceBind = false
    const deadline = Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
    // Disposal ends the observation; the held keys are then recovered, never dropped.
    observation = new AbortController()
    void waitForAgentDraftInputReady(
      ptyId,
      GENERATED_AGENT_INPUT_TIMEOUT_MS,
      TUI_AGENT_CONFIG[draftAgent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste',
      draftAgent,
      observation.signal
    )
      .then((ready) => (ready ? pasteDraft(ptyId, draftAgent, deadline) : recoverDraft(draftAgent)))
      .catch(() => recoverDraft(draftAgent))
  }

  session.discardAgentPreReadyDraft = (): void => {
    observation?.abort()
    const draftAgent = resolveAgent()
    if (draftAgent) {
      recoverDraft(draftAgent)
    }
  }
}

function joinDraftText(existing: string | null, typed: string): string {
  if (!existing) {
    return typed
  }
  return /\s$/.test(existing) ? `${existing}${typed}` : `${existing} ${typed}`
}
