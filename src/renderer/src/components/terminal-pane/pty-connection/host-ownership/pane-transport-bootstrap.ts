import { useAppStore } from '@/store'
import { ambiguousWorkspaceOwnerMessage } from '@/lib/duplicate-paired-servers'
import { createIpcPtyTransport } from '../../pty-transport/ipc/pty-transport'
import { createRemoteRuntimePtyTransport } from '../../pty-transport/remote-runtime/remote-runtime-pty-transport'
import { toAgentLaunchPreferences } from '../../../../../../shared/agent-launch/choices/agent-launch-preferences'
import { createUnresolvedOwnerPtyTransport } from '../../pty-transport/host-ownership/unresolved-owner-pty-transport'
import { recordTerminalTabParkedOnUnresolvedHost } from '@/lib/parked-terminal-host-hydration'
import { buildPaneTransportOptions } from '../pane-transport-options'
import { createUnservedSshRowTransport } from './unserved-ssh-pane-connect'
import { createLegacyRelayBridgeTransport } from '../../pty-transport/legacy-relay/legacy-relay-bridge-transport'
import { legacyRelayBridgePtyIdForPane } from '../../pty-transport/legacy-relay/legacy-relay-bridge-panes'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'

/** COMPAT(legacy-relay-bridge, revisit 2027-01-15): a pane an older Orca's relay still runs. */
function withLegacyRelayBridge(session: ConnectPanePtySession, inner: PtyTransport): PtyTransport {
  const leafId = session.deps.restoredLeafId ?? session.pane.leafId
  const ptyId = legacyRelayBridgePtyIdForPane({
    tabId: session.deps.tabId,
    leafId,
    boundPtyId:
      (leafId ? session.deps.restoredPtyIdByLeafId?.[leafId] : undefined) ??
      useAppStore
        .getState()
        .tabsByWorktree[session.deps.worktreeId]?.find((tab) => tab.id === session.deps.tabId)
        ?.ptyId
  })
  session.legacyRelayBridgePtyId = ptyId
  return ptyId ? createLegacyRelayBridgeTransport(ptyId, inner) : inner
}

export function installPaneTransport(session: ConnectPanePtySession): void {
  session.terminalTheme = session.pane.terminal.options.theme
  session.terminalColorQueryReplies = session.terminalTheme
    ? { foreground: session.terminalTheme.foreground, background: session.terminalTheme.background }
    : undefined
  const launchAgent = session.paneStartup?.launchAgent
  session.agentLaunchPreferences = launchAgent
    ? toAgentLaunchPreferences(session.paneStartup?.sessionOptions, launchAgent)
    : undefined
  session.transportOptions = buildPaneTransportOptions(session)
  if (session.connectionOwnerHydrating) {
    // Register unresolved-host panes for repo-change remount so hydration cannot leave an inert blank terminal.
    recordTerminalTabParkedOnUnresolvedHost(session.deps.worktreeId, session.deps.tabId)
  }
  session.transport =
    session.terminalOwnerUnresolved || session.connectionOwnerHydrating
      ? createUnresolvedOwnerPtyTransport(
          session.terminalOwnerUnresolved
            ? ambiguousWorkspaceOwnerMessage(useAppStore.getState(), session.deps.worktreeId)
            : 'Workspace host is still loading. Retry when the project finishes hydrating.'
        )
      : session.unservedSshTargetId
        ? createUnservedSshRowTransport(session, session.unservedSshTargetId)
        : session.runtimeEnvironmentId
          ? withLegacyRelayBridge(
              session,
              createRemoteRuntimePtyTransport(
                session.runtimeEnvironmentId,
                session.transportOptions
              )
            )
          : createIpcPtyTransport(session.transportOptions)
}
