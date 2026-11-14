import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { useAppStore } from '@/store'
import { registerTerminalSideEffectFactConsumer } from '../../pty-transport/output/terminal-side-effect-facts-handler'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindPaneSideEffectFacts(session: ConnectPanePtySession): void {
  // Main-authority facts replace byte parsers as the single policy consumer; title snapshots restore metadata without attention replay.
  session.unregisterSideEffectFactConsumer = null
  session.registerSideEffectFactConsumerForPty = (
    ptyId: string,
    remoteOutputPaused = false
  ): void => {
    if ((!session.mainSideEffectAuthority && !remoteOutputPaused) || session.disposed) {
      return
    }
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = registerTerminalSideEffectFactConsumer({
      ptyId,
      callbacks: {
        onTitleChange: session.onTitleChange,
        onBell: session.onBell,
        onAgentBecameIdle: session.onAgentBecameIdle,
        onAgentBecameWorking: session.onAgentBecameWorking,
        onAgentExited: session.onAgentExited,
        onCommandFinished: session.handleCommandFinished,
        onPrLink: (link) =>
          useAppStore
            .getState()
            .observeTerminalGitHubPullRequestLink(session.deps.worktreeId, link, {
              tabId: session.deps.tabId,
              paneKey: makePaneKey(session.deps.tabId, session.pane.leafId),
              ptyId: session.transport.getPtyId(),
              executionHostId: session.transport.getExecutionHostId?.() ?? undefined
            }),
        // Pane policy owns Command Code settling against the live row; main supplies scrape facts only.
        onCommandCodeWorking: session.seedCommandCodeOutputWorkingStatus,
        onCommandCodeDone: session.scheduleCommandCodeOutputDoneStatus,
        ...(session.shouldOwnAgentStatusInRenderer
          ? { onAgentStatus: (payload) => session.handleRendererOwnedAgentStatus(payload) }
          : {}),
        // Why: gated hidden panes never see the subscribe bytes; the fact
        // replaces the byte scan (and the old post-latch subscribe drop).
        ...(session.hiddenDeliveryGateActive || remoteOutputPaused
          ? {
              onMode2031Subscribe: session.handleHiddenMode2031SubscribeFact,
              onMode2031Unsubscribe: session.handleHiddenMode2031UnsubscribeFact
            }
          : {})
      },
      restoreTitleOnRegister: true
    })
  }
  session.dropSideEffectFactConsumer = (): void => {
    session.unregisterSideEffectFactConsumer?.()
    session.unregisterSideEffectFactConsumer = null
    session.remoteOutputFactConsumerPtyId = null
  }
}
