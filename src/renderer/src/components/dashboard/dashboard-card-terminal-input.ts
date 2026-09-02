import type { AppState } from '@/store/types'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { shouldDisableKittyKeyboardForTerminal } from '@/lib/pane-manager/terminal-keyboard-protocol'
import { isLocalNativeWindowsConpty } from '@/lib/pane-manager/windows-pty-compatibility'
import { resolveTerminalInputHostPlatform } from '@/components/terminal-pane/terminal-input-host-platform'
import { resolveWindowsShiftEnterEncodingForPane } from '@/components/terminal-pane/terminal-windows-shift-enter'
import { hasCtrlEnterCsiUAuthorityForPane } from '@/components/terminal-pane/terminal-ctrl-enter'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { resolveProtectedMultilinePasteOptionsForAgentEvidence } from '@/components/terminal-pane/terminal-agent-paste-bracketing'

/** Store slices the pane's own input helpers read. */
export type DashboardCardTerminalInputState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'settings'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'runtimeStatusByEnvironmentId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'paneForegroundAgentByPaneKey'
  | 'agentStatusByPaneKey'
  | 'agentLaunchConfigByPaneKey'
>

const EMPTY_RECORD = {} as Record<string, never>

/** Why: the snapshot builder must never throw on a partially hydrated store —
 *  a missing slice degrades one card to client-OS defaults, not a blank board. */
function withHydratedSlices(
  state: Partial<DashboardCardTerminalInputState>
): DashboardCardTerminalInputState {
  return {
    repos: state.repos ?? [],
    worktreesByRepo: state.worktreesByRepo ?? EMPTY_RECORD,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? EMPTY_RECORD,
    folderWorkspaces: state.folderWorkspaces ?? [],
    projectGroups: state.projectGroups ?? [],
    settings: state.settings ?? null,
    sshConnectionStates: state.sshConnectionStates ?? new Map(),
    sshStateByEnvironment: state.sshStateByEnvironment ?? new Map(),
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId ?? new Map(),
    restoredRuntimeHostIdByWorkspaceSessionKey:
      state.restoredRuntimeHostIdByWorkspaceSessionKey ?? EMPTY_RECORD,
    runtimeEnvironments: state.runtimeEnvironments ?? [],
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated ?? false,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds ?? new Set(),
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey ?? EMPTY_RECORD,
    agentStatusByPaneKey: state.agentStatusByPaneKey ?? EMPTY_RECORD,
    agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey ?? EMPTY_RECORD
  }
}

/**
 * Resolve the host-dependent input facts a card's preview terminal needs to
 * encode keys like the agent's own pane. Store-derived only — the board holds no
 * live PtyTransport, so the shared pane helpers run their fallback path, the
 * same one a pane itself uses before its transport attaches.
 */
export function resolveDashboardCardTerminalInput(
  partialState: Partial<DashboardCardTerminalInputState>,
  args: {
    ptyId: string
    worktreeId: string
    paneKey: string
    /** Worktree path — decides WSL vs native Windows for a local pty. */
    cwd: string
    shellOverride: string | null | undefined
    launchAgent: TuiAgent | null | undefined
    clientPlatform: NodeJS.Platform
    userAgent: string
    osRelease: string | undefined
  }
): DashboardCardTerminalInput {
  const state = withHydratedSlices(partialState)
  const sshPty = parseAppSshPtyId(args.ptyId)
  const runtimeEnvironmentId = getRemoteRuntimePtyEnvironmentId(args.ptyId)
  const connectionId =
    sshPty?.connectionId ??
    (runtimeEnvironmentId ? null : getConnectionIdFromState(state, args.worktreeId))
  const executionHostId = sshPty
    ? toSshExecutionHostId(sshPty.connectionId)
    : runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : getExecutionHostIdForWorktree(state, args.worktreeId)
  const windowsPtyContext = {
    userAgent: args.userAgent,
    osRelease: args.osRelease,
    connectionId,
    cwd: args.cwd,
    shellOverride: args.shellOverride,
    executionHostId
  }
  const hostPlatform = resolveTerminalInputHostPlatform({
    clientPlatform: args.clientPlatform,
    state,
    worktreeId: args.worktreeId,
    transport: {
      getConnectionId: () => connectionId,
      getPtyId: () => args.ptyId,
      getExecutionHostId: () => executionHostId,
      // Why: gated exactly like the pane transport's own accessor — without
      // it a WSL pty on a Windows client resolves to win32 and Shift+Enter
      // would encode CSI-u where the pane sends alt-enter.
      getLocalSessionMetadata: () =>
        connectionId
          ? null
          : {
              ...(args.cwd ? { cwd: args.cwd } : {}),
              ...(args.shellOverride ? { shellOverride: args.shellOverride } : {})
            }
    }
  })
  const protectedPaste = resolveProtectedMultilinePasteOptionsForAgentEvidence({
    isWindowsClient: args.clientPlatform === 'win32',
    hostPlatform,
    foregroundAgent: state.paneForegroundAgentByPaneKey[args.paneKey]?.agent,
    entry: state.agentStatusByPaneKey[args.paneKey]
  })
  return {
    hostPlatform,
    localWindowsConpty: isLocalNativeWindowsConpty(windowsPtyContext),
    ...(args.osRelease === undefined ? {} : { osRelease: args.osRelease }),
    windowsShiftEnterEncoding: resolveWindowsShiftEnterEncodingForPane(state, args.paneKey),
    ...(protectedPaste?.forceBracketedPasteForMultiline
      ? { forceBracketedMultilineTextPaste: true as const }
      : {}),
    ...(protectedPaste?.windowsInputRecordNewline
      ? { windowsInputRecordPasteNewline: protectedPaste.windowsInputRecordNewline }
      : {}),
    ctrlEnterCsiU: hasCtrlEnterCsiUAuthorityForPane(state, args.paneKey),
    kittyKeyboardAdvertised: !shouldDisableKittyKeyboardForTerminal({
      ...windowsPtyContext,
      // Why: launch identity is the only agent signal the board holds; it opts
      // Grok out of the ConPTY kitty withhold exactly as its pane does.
      tuiAgent: args.launchAgent ?? null
    })
  }
}
