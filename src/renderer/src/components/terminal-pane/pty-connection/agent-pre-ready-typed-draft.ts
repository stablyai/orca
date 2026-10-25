// Keys typed into an agent pane before its PTY binds would land ahead of the launch line, so they
// are kept as an unsubmitted draft and pasted once the agent is ready. Keys typed after the bind
// always go live; the draft is dropped instead of pasted over a screen the user is driving.

import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../shared/draft-paste-ready-timeout'
import { waitForAgentDraftInputReady } from '@/lib/agent-draft-readiness'
import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { PTY_PRECONNECT_INPUT_MAX_CODE_UNITS } from '../pty-preconnect-input-buffer'
import { writeTerminalPastePtyInput } from '../terminal-pty-paste-writer'
import { findColdRestoreResumeSource } from './cold-restore-resume-startup'
import { paneHasStartupWork } from './pane-transport-options'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const BACKSPACE = '\x7f'
const CTRL_H = '\b'

/**
 * Adds typed bytes to a draft: printable text only. Enter, Tab, other control keys and escape
 * sequences are dropped so nothing submits or edits; Backspace deletes the last character. Line
 * breaks inside a multi-character chunk (a paste) become one space so words don't run together.
 */
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
        // Only keys before the first bind are held; a later unbind (exit, hibernation, a remote
        // re-attach) keeps today's path, where the host may hold and deliver them itself.
        phase = draft === '' ? 'closed' : 'delivering'
      }
      return false
    }
    if (phase !== 'capturing') {
      return false
    }
    if (wasUserInput) {
      draft = appendTypedDraftText(draft, data, PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
    }
    // Pre-bind focus reports have no terminal to reach.
    return true
  }

  const dropDraft = (draftAgent: TuiAgent): void => {
    const dropped = draft !== ''
    draft = ''
    phase = 'closed'
    if (dropped && !session.disposed) {
      createPasteReadinessTimeoutNotice({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        agent: draftAgent,
        submitted: false
      }).onTimeout()
    }
  }

  const pasteDraft = async (ptyId: string, draftAgent: TuiAgent): Promise<void> => {
    if (session.disposed || session.transport.getPtyId() !== ptyId) {
      draft = ''
      phase = 'closed'
      return
    }
    const status = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.state
    // Why drop: the user is already driving the screen, or a prompt is waiting on an answer.
    if (liveInputSinceBind || status === 'blocked' || status === 'waiting') {
      dropDraft(draftAgent)
      return
    }
    const text = draft
    draft = ''
    phase = 'closed'
    // Why merge: a launch-time draft not yet pasted sends both as one, in typing order.
    if (session.ownsStartupDraftPaste && !session.startupDraftPasteAttempted) {
      session.startupDraftPrompt = joinDraftText(session.startupDraftPrompt, text)
      return
    }
    await sendAgentDraftPasteContent(ptyId, text, 'driving', (data) =>
      writeTerminalPastePtyInput(session.transport, data, 'driving')
    ).catch(() => false)
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
    liveInputSinceBind = false
    phase = 'delivering'
    if (!freshSpawn) {
      // Why drop: an attached pane can still be at the shell before main types the launch line,
      // where a paste would prefix the command.
      dropDraft(draftAgent)
      return
    }
    void waitForAgentDraftInputReady(
      ptyId,
      resolveDraftPasteReadyTimeoutMs(draftAgent),
      TUI_AGENT_CONFIG[draftAgent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
    ).then((ready) => (ready ? pasteDraft(ptyId, draftAgent) : dropDraft(draftAgent)))
  }

  session.discardAgentPreReadyDraft = (): void => {
    draft = ''
    phase = 'closed'
  }
}

function joinDraftText(existing: string | null, typed: string): string {
  if (!existing) {
    return typed
  }
  return /\s$/.test(existing) ? `${existing}${typed}` : `${existing} ${typed}`
}
