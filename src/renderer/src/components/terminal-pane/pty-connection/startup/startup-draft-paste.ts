import { createPasteReadinessTimeoutNotice } from '@/lib/agent-session/launch/prompt/launch-agent-paste-timeout-notice'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../../../shared/generated-agent-input-readiness'
import { deliverGeneratedPaste } from '@/lib/agent-paste-draft'
import { acceptGeneratedInput } from '@/lib/generated-paste-notice'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindStartupDraftPaste(session: ConnectPanePtySession): void {
  // Providers own startup delivery across renderer replacement; only explicit terminal paste stays renderer-owned.
  session.pendingStartupCommand = session.shouldDeliverStartupViaTerminalPaste
    ? session.paneStartup?.command
      ? { command: session.paneStartup.command, resumeSource: session.paneStartup.resumeSource }
      : null
    : null
  const startupSource = session.paneStartup?.resumeSource
  let armed = false
  let settled = !session.ownsStartupDraftPaste
  let handedOff = false
  const recover = (certainty: 'not-sent' | 'unconfirmed', retained = false): void => {
    if (settled) {
      return
    }
    settled = true
    session.startupDraftPasteAttempted = true
    const content = session.startupDraftPrompt
    if (content && session.startupDraftAgent) {
      session.startupDraftOperationId ??= acceptGeneratedInput({
        text: content,
        agent: session.startupDraftAgent,
        submit: false
      })
    }
    session.startupDraftPrompt = null
    if (content && session.startupDraftAgent) {
      createPasteReadinessTimeoutNotice({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        agent: session.startupDraftAgent,
        submitted: false,
        content,
        operationId: session.startupDraftOperationId
      }).onTimeout(certainty, retained)
    }
  }
  // Once handed to the host the draft outlives this pane: parking or closing it does not cancel.
  session.cleanupStartupDraftPasteTimers = (): void => {
    if (!handedOff) {
      recover('not-sent')
    }
  }
  const currentPty = (): string | null => {
    return !session.disposed &&
      !startupSource?.cancelled &&
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
      ? session.transport.getPtyId()
      : null
  }
  // The host that owns the PTY waits for the agent and stages the draft in one transaction.
  const begin = (): void => {
    const ptyId = currentPty()
    if (!armed || handedOff || settled || !ptyId) {
      return
    }
    // Seal held keys with the startup draft even if output races the bind callback.
    session.onAgentPreReadyDraftPtyBound?.(ptyId, session.spawnedFreshPtyId === ptyId)
    handedOff = true
    const content = session.startupDraftPrompt
    if (!content) {
      settled = true
      return
    }
    session.startupDraftOperationId ??= acceptGeneratedInput({
      text: content,
      agent: session.startupDraftAgent,
      submit: false
    })
    session.startupDraftPasteAttempted = true
    let retained = false
    void deliverGeneratedPaste({
      ptyId,
      content,
      submit: false,
      agent: session.startupDraftAgent ?? undefined,
      inputKind: 'launch',
      intent: 'startup',
      deadline: Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS,
      operationId: session.startupDraftOperationId,
      onNoticeRetained: () => (retained = true)
    }).then((outcome) => {
      if (outcome === 'staged' || outcome === 'delivered') {
        settled = true
        session.startupDraftPrompt = null
        // Transport-free paste bypasses xterm's input signal; record it so hibernation keeps the draft.
        session.recordTerminalInputForHibernation()
        return
      }
      recover(outcome === 'unconfirmed' ? 'unconfirmed' : 'not-sent', retained)
    })
  }
  session.armStartupDraftReadinessObservation = (): void => {
    armed = true
    begin()
  }
  session.observeStartupDraftPasteReadiness = (): void => begin()
  if (
    session.ownsStartupDraftPaste &&
    !session.unservedSshTargetId &&
    !session.shouldDeliverStartupViaTerminalPaste
  ) {
    session.armStartupDraftReadinessObservation()
  }
}
