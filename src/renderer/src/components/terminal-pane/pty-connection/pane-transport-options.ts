import { useAppStore } from '@/store'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'
import type { IpcPtyTransportOptions } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** The spawn/attach options a pane hands its PTY transport. */
export function buildPaneTransportOptions(session: ConnectPanePtySession): IpcPtyTransportOptions {
  return {
    terminalKittyKeyboardProtocol:
      session.pane.terminal.options.vtExtensions?.kittyKeyboard === true,
    cwd: session.deps.cwd,
    ...(session.deps.cwdPromise ||
    session.deps.preconnectInput?.length ||
    session.buffersInputOnlyForReattach
      ? { bufferInputUntilConnect: true }
      : {}),
    ...(session.deps.preconnectInput?.length
      ? { preconnectInput: session.deps.preconnectInput }
      : {}),
    ...(session.deps.onPreconnectInput
      ? { onPreconnectInput: session.deps.onPreconnectInput }
      : {}),
    // Why: only fresh local IPC spawns may recover from a saved startup cwd
    // whose directory was deleted (#7239); remote-runtime and SSH spawns
    // resolve cwd on another host and must keep exact cwd semantics.
    ...(session.runtimeEnvironmentId === null && !session.connectionId
      ? { cwdFallback: 'worktree' as const }
      : {}),
    env: session.paneEnv,
    ...(session.paneStartup?.envToDelete ? { envToDelete: session.paneStartup.envToDelete } : {}),
    command: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.command,
    ...(session.shouldUseProviderSshStartupDelivery
      ? { commandDelivery: 'provider' as const }
      : {}),
    startupCommandDelivery: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.connectionId && session.paneStartup?.command
        ? 'shell-ready'
        : session.paneStartup?.startupCommandDelivery,
    connectionId: session.connectionId,
    executionHostId: session.executionHostId,
    worktreeId: session.deps.worktreeId,
    // Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
    // main sync-flush the (worktreeId, tabId, leafId → ptyId) binding before
    // pty:spawn returns. Daemon-host-only: SSH path leaves these undefined
    // and the main-side guard short-circuits.
    tabId: session.deps.tabId,
    leafId: session.pane.leafId,
    ...(session.deps.placement ? { placement: session.deps.placement } : {}),
    activate: session.deps.isActiveRef.current && session.deps.isVisibleRef.current,
    ...(session.shellOverride ? { shellOverride: session.shellOverride } : {}),
    ...(session.projectRuntime ? { projectRuntime: session.projectRuntime } : {}),
    ...(session.terminalColorQueryReplies
      ? { terminalColorQueryReplies: session.terminalColorQueryReplies }
      : {}),
    ...(session.paneStartup?.launchConfig
      ? { launchConfig: session.paneStartup.launchConfig }
      : {}),
    ...(session.paneStartup?.resumeProviderSession
      ? { resumeProviderSession: session.paneStartup.resumeProviderSession }
      : {}),
    ...((session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt)
      ? {
          agentPrompt:
            session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt
        }
      : {}),
    ...(session.paneStartup?.initialAgentStatus?.prompt
      ? { agentPromptDelivery: 'auto-submit' as const }
      : session.paneStartup?.draftPrompt
        ? { agentPromptDelivery: 'draft' as const }
        : {}),
    ...(session.paneStartup?.agentArgsOverride !== undefined
      ? { agentArgsOverride: session.paneStartup.agentArgsOverride }
      : {}),
    ...(session.agentLaunchPreferences
      ? { agentLaunchPreferences: session.agentLaunchPreferences }
      : {}),
    ...(session.launchToken ? { launchToken: session.launchToken } : {}),
    ...(session.paneStartup?.launchAgent ? { launchAgent: session.paneStartup.launchAgent } : {}),
    ...(session.paneStartup?.telemetry ? { telemetry: session.paneStartup.telemetry } : {}),
    onPtyExit: session.onExit,
    onPtySpawn: session.onPtySpawn,
    onPtyRebind: session.onPtyRebind,
    retainDisposedSpawn: () =>
      shouldRetainDisposedPaneSpawn(
        useAppStore.getState(),
        session.deps.worktreeId,
        session.deps.tabId,
        session.pane.leafId,
        session.executionHostId
      ),
    ...(session.mainSideEffectAuthority
      ? {}
      : {
          onTitleChange: session.onTitleChange,
          onBell: session.onBell,
          onAgentBecameIdle: session.onAgentBecameIdle,
          onAgentBecameWorking: session.onAgentBecameWorking,
          onAgentExited: session.onAgentExited
        }),
    // Why: local IPC terminals are now model-owned in main: OrcaRuntimeService
    // parses OSC 9999 before renderer delivery and forwards through the hook
    // server with local/SSH identity. Remote-runtime streams do not pass through
    // local main, so the renderer remains their status owner for now.
    ...(session.shouldOwnAgentStatusInRenderer
      ? { onAgentStatus: session.handleRendererOwnedAgentStatus }
      : {})
  }
}
