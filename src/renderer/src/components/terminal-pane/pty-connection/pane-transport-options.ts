import { useAppStore } from '@/store'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'
import { findColdRestoreResumeSource } from './cold-restore-resume-startup'
import { mainStartsPane } from './main-starts-pane'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import type { IpcPtyTransportOptions } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** A split waiting on its inherited cwd, or remounted with handed-off keys; it holds keys as before. */
export function isDeferredSplitInputHold(session: ConnectPanePtySession): boolean {
  return Boolean(session.deps.cwdPromise || session.deps.preconnectInput?.length)
}

/** Startup command, agent resume, or main-owned launch that runs after PTY binding. */
export function paneHasStartupWork(session: ConnectPanePtySession): boolean {
  return paneHasKnownStartupWork(session) || mainStartsPane(session)
}

function paneHasKnownStartupWork(session: ConnectPanePtySession): boolean {
  const state = useAppStore.getState()
  return Boolean(
    session.paneStartup ||
    session.getSleepingRecordForPane(state) ||
    findColdRestoreResumeSource(session, state)
  )
}

/** Hold pre-bind keys only for plain/deferred shells. Flushing ahead of startup work could run a prompt
 * as a shell command or corrupt the launch; agent panes retain a draft (agent-pre-ready-typed-draft.ts). */
function holdsInputUntilConnect(session: ConnectPanePtySession): boolean {
  if (isDeferredSplitInputHold(session)) {
    // Why not mainStartsPane: a deferred split keeps holding under the layout-owner build, as before.
    return !paneHasKnownStartupWork(session)
  }
  return !paneHasStartupWork(session)
}

export function buildPaneTransportOptions(session: ConnectPanePtySession): IpcPtyTransportOptions {
  const holdsInput = holdsInputUntilConnect(session)
  return {
    terminalKittyKeyboardProtocol:
      session.pane.terminal.options.vtExtensions?.kittyKeyboard === true,
    cwd: session.deps.cwd,
    ...(holdsInput
      ? {
          bufferInputUntilConnect: true,
          // Why: a resume source can land between mount and bind; keys must not flush ahead of it.
          releasePreconnectInput: () => holdsInputUntilConnect(session)
        }
      : {}),
    // Why gated: a seed alone arms the transport hold, which would flush ahead of startup work.
    ...(holdsInput && session.deps.preconnectInput?.length
      ? { preconnectInput: session.deps.preconnectInput }
      : {}),
    ...(session.deps.onPreconnectInput
      ? { onPreconnectInput: session.deps.onPreconnectInput }
      : {}),
    env: session.paneEnv,
    ...(session.paneStartup?.envToDelete ? { envToDelete: session.paneStartup.envToDelete } : {}),
    command: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.command,
    startupCommandDelivery: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.startupCommandDelivery,
    executionHostId: session.executionHostId,
    worktreeId: session.deps.worktreeId,
    // Flush pane↔PTY binding before spawn reply so a SIGKILL cannot lose it.
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
    ...(session.paneStartup?.agentLaunch ? { agentLaunch: session.paneStartup.agentLaunch } : {}),
    ...(session.paneStartup?.telemetry ? { telemetry: session.paneStartup.telemetry } : {}),
    onPtyExit: session.onExit,
    onPtySpawn: session.onPtySpawn,
    onPtyRebind: session.onPtyRebind,
    // Why a remount: the exit already tore down this mount's PTY state, so a fresh mount attaches.
    onHostReboundExitedPty: (ptyId) =>
      void requestTerminalPaneRecovery({
        tabId: session.deps.tabId,
        ptyId,
        reason: 'host-rebound-exited-pane',
        // Why: a new host process is fresh evidence a failed attempt can't refuse; the cap still holds.
        trigger: 'host-evidence',
        terminalRecoveryGeneration: session.terminalRecoveryGeneration,
        terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
      }),
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
    // Local main owns OSC 9999 and forwards hook identity; remote-runtime streams bypass main and retain renderer ownership.
    ...(session.shouldOwnAgentStatusInRenderer
      ? { onAgentStatus: session.handleRendererOwnedAgentStatus }
      : {})
  }
}
