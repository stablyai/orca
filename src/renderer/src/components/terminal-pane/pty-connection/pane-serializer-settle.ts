import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { SessionRestoredBannerReason } from '../session-restored-banner-pane-state'
import { hasPtySerializer } from '../pty-buffer-serializer'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../shared/draft-paste-ready-timeout'
import { waitForAgentDraftInputReady, agentInputIsAdmitted } from '@/lib/agent-draft-readiness'
import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import { writeTerminalPastePtyInput } from '../terminal-pty-paste-writer'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindSettlePaneSerializer(session: ConnectPanePtySession): void {
  session.settlePaneSerializerAfterReplay = async (
    ptyId: string,
    generation: number
  ): Promise<void> => {
    try {
      await session.replayWriteQueue
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        await window.api.pty
          .clearPendingPaneSerializer(session.cacheKey, generation)
          .catch(() => {})
        return
      }
      await waitForTerminalOutputParsed(session.pane.terminal)
      if (!session.disposed && session.transport.getPtyId() === ptyId) {
        await window.api.pty.settlePaneSerializer(session.cacheKey, generation)
        return
      }
    } catch {
      // Clear below so a failed parser/replay cannot leave the pane generation pending.
    }
    await window.api.pty.clearPendingPaneSerializer(session.cacheKey, generation).catch(() => {})
  }
  session.reportRemoteRendererSerializerReady = (): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      return
    }
    if (!hasPtySerializer(ptyId)) {
      session.registerPaneSerializerFor(ptyId)
    }
    // Join async snapshot replay and xterm parse after onSubscribed before declaring readiness.
    void session.replayWriteQueue
      .then(() => waitForTerminalOutputParsed(session.pane.terminal))
      .then(() => {
        if (!session.disposed && session.transport.getPtyId() === ptyId) {
          void window.api.pty.reportRendererSerializerReady?.(ptyId)
        }
      })
      .catch(() => {})
  }

  // Providers own startup delivery across renderer replacement; only explicit terminal paste stays renderer-owned.
  session.pendingStartupCommand = session.shouldDeliverStartupViaTerminalPaste
    ? session.paneStartup?.command
      ? { command: session.paneStartup.command, resumeSource: session.paneStartup.resumeSource }
      : null
    : null
  const startupSource = session.paneStartup?.resumeSource
  let armed = false
  let settled = !session.ownsStartupDraftPaste
  let running = false
  let recorded = false
  const stop = new AbortController()
  const recover = (certainty: 'not-sent' | 'unconfirmed' = 'not-sent'): void => {
    if (settled) {
      return
    }
    settled = true
    session.startupDraftPasteAttempted = true
    const content = session.startupDraftPrompt
    session.startupDraftPrompt = null
    if (content && session.startupDraftAgent) {
      createPasteReadinessTimeoutNotice({
        worktreeId: session.deps.worktreeId,
        tabId: session.deps.tabId,
        agent: session.startupDraftAgent,
        submitted: false,
        content
      }).onTimeout(certainty)
    }
  }
  session.cleanupStartupDraftPasteTimers = (): void => {
    stop.abort()
    recover(recorded ? 'unconfirmed' : 'not-sent')
  }
  const currentPty = (): string | null => {
    return !session.disposed &&
      !startupSource?.cancelled &&
      session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
      ? session.transport.getPtyId()
      : null
  }
  const begin = (initialData = ''): void => {
    const ptyId = currentPty()
    if (!armed || running || settled || !ptyId) {
      return
    }
    running = true
    const timeoutMs = resolveDraftPasteReadyTimeoutMs(session.startupDraftAgent ?? undefined)
    const deadline = Date.now() + timeoutMs
    void waitForAgentDraftInputReady(
      ptyId,
      timeoutMs,
      session.startupDraftAgentConfig?.draftPasteReadySignal ??
        'render-quiet-after-bracketed-paste',
      session.startupDraftAgent ?? undefined,
      stop.signal,
      initialData
    )
      .then(async (ready) => {
        if (!ready || currentPty() !== ptyId) {
          return recover()
        }
        const content = session.startupDraftPrompt
        if (!content) {
          settled = true
          return
        }
        session.startupDraftPasteAttempted = true
        const sent = await sendAgentDraftPasteContent(ptyId, content, 'launch', async (data) => {
          if (
            currentPty() !== ptyId ||
            !(await agentInputIsAdmitted(ptyId, session.startupDraftAgent ?? undefined)) ||
            Date.now() >= deadline
          ) {
            return false
          }
          recorded = true
          const accepted = await writeTerminalPastePtyInput(session.transport, data, 'launch')
          if (accepted) {
            session.recordTerminalInputForHibernation()
          }
          return accepted
        })
        if (!sent) {
          return recover(recorded ? 'unconfirmed' : 'not-sent')
        }
        settled = true
        session.startupDraftPrompt = null
      })
      .catch(() => recover(recorded ? 'unconfirmed' : 'not-sent'))
  }
  session.armStartupDraftReadinessObservation = (): void => {
    armed = true
    begin()
  }
  session.observeStartupDraftPasteReadiness = (data: string): void => begin(data)
  if (
    session.ownsStartupDraftPaste &&
    !session.unservedSshTargetId &&
    !session.shouldDeliverStartupViaTerminalPaste
  ) {
    session.armStartupDraftReadinessObservation()
  }
  let sessionRestoredBannerShown: SessionRestoredBannerReason | null = null
  session.showSessionRestoredBanner = (reason: SessionRestoredBannerReason = 'restored'): void => {
    // Allow unavailable outcome to replace restored wording; an earlier plain banner cannot certify a session that failed to resume.
    if (
      sessionRestoredBannerShown === reason ||
      sessionRestoredBannerShown === 'resume-unavailable'
    ) {
      return
    }
    sessionRestoredBannerShown = reason
    session.deps.onShowSessionRestoredBanner(session.pane.id, reason)
  }
}
