// Pre-bind keys would prefix the launch command; draft until agent readiness and recover if the user starts driving the live screen.

import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../../shared/generated-agent-input-readiness'
import { deliverGeneratedPaste } from '@/lib/agent-paste-draft'
import { waitForPaneAgentToLookReady } from '@/lib/agent-draft-readiness'
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
  let observation: AbortController | null = null
  let takeover: AbortController | null = null
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
      // A person typing after the handoff takes the terminal over: the held keys' request is
      // cancelled before this input is forwarded, and its outcome recovers them.
      if (wasUserInput) {
        takeover?.abort()
      }
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

  /** Before handoff only: the pane still owns the exact keys and recovers them once. */
  const recoverDraft = (draftAgent: TuiAgent, certainty: 'not-sent' | 'unconfirmed'): void => {
    const content = draft
    draft = ''
    phase = 'closed'
    if (content !== '') {
      showHeldKeysNotice(draftAgent, content, certainty)
    }
  }
  const showHeldKeysNotice = (
    draftAgent: TuiAgent,
    content: string,
    certainty: 'not-sent' | 'unconfirmed'
  ): void => {
    createPasteReadinessTimeoutNotice({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      agent: draftAgent,
      submitted: false,
      content
    }).onTimeout(certainty)
  }

  /** The one ownership handoff: the operation now owns the keys, and its outcome alone decides
   *  whether they are recovered. Closing the pane no longer touches them. */
  const handOffDraft = (ptyId: string, draftAgent: TuiAgent, deadline: number): void => {
    const content = draft
    draft = ''
    phase = 'closed'
    observation = null
    const cancel = new AbortController()
    takeover = cancel
    void deliverGeneratedPaste({
      ptyId,
      content,
      submit: false,
      agent: draftAgent,
      inputKind: 'driving',
      intent: 'startup',
      // The same deadline the pane's observation spent: no second, fresh budget.
      deadline,
      signal: cancel.signal
    }).then((outcome) => {
      if (takeover === cancel) {
        takeover = null
      }
      // Exhaustive: every outcome either hands the keys over or recovers them exactly once.
      switch (outcome) {
        case 'staged':
        case 'delivered':
          return
        case 'not-sent':
        case 'target-gone':
          return showHeldKeysNotice(draftAgent, content, 'not-sent')
        case 'unconfirmed':
          return showHeldKeysNotice(draftAgent, content, 'unconfirmed')
        default: {
          const unhandled: never = outcome
          return unhandled
        }
      }
    })
  }

  /** The pane's observation only times the handoff; the user driving the screen keeps the keys. */
  const pasteDraft = (ptyId: string, draftAgent: TuiAgent, deadline: number): void => {
    if (session.disposed || session.transport.getPtyId() !== ptyId) {
      recoverDraft(draftAgent, 'not-sent')
      return
    }
    const status = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.state
    // The user is already driving the screen, or a prompt is waiting on an answer.
    if (liveInputSinceBind || status === 'blocked' || status === 'waiting') {
      recoverDraft(draftAgent, 'not-sent')
      return
    }
    handOffDraft(ptyId, draftAgent, deadline)
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
      recoverDraft(draftAgent, 'not-sent')
      return
    }
    liveInputSinceBind = false
    const deadline = Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
    // Before handoff, disposal ends this observation and the pane recovers the keys.
    const pending = new AbortController()
    observation = pending
    void waitForPaneAgentToLookReady(
      ptyId,
      draftAgent,
      GENERATED_AGENT_INPUT_TIMEOUT_MS,
      pending.signal
    )
      .then((ready) => {
        if (observation !== pending) {
          return
        }
        if (ready) {
          pasteDraft(ptyId, draftAgent, deadline)
        } else {
          recoverDraft(draftAgent, 'not-sent')
        }
      })
      .catch(() => {
        if (observation === pending) {
          recoverDraft(draftAgent, 'not-sent')
        }
      })
  }

  session.discardAgentPreReadyDraft = (): void => {
    // After handoff the operation owns the keys; there is nothing here to recover.
    if (phase === 'closed') {
      return
    }
    observation?.abort()
    observation = null
    const draftAgent = resolveAgent()
    if (draftAgent) {
      recoverDraft(draftAgent, 'not-sent')
    }
  }
}

function joinDraftText(existing: string | null, typed: string): string {
  if (!existing) {
    return typed
  }
  return /\s$/.test(existing) ? `${existing}${typed}` : `${existing} ${typed}`
}
