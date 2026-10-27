import type { AppState } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  isWslShellName,
  resolveLocalWindowsTerminalRuntimeOptions,
  type LocalWindowsTerminalRuntimeOptions
} from '../../../shared/local-windows-terminal-runtime'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { resolveTerminalStartupCwd } from '../../../shared/terminal-startup-cwd'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { getRendererAppPlatform } from './renderer-app-platform'
import { wslHostDistroForTarget } from './wsl-host-account-owner'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from './windows-terminal-capabilities'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type CodexPaneLaneState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projects'
  | 'repos'
  | 'runtimeEnvironments'
  | 'settings'
  | 'worktreesByRepo'
>

/** Foreign machines have independent credentials; assign distinct lanes so local host/WSL account switches cannot mute their panes. */
const RUNTIME_ENVIRONMENT_LANE_PREFIX = 'env:'
const SSH_CONNECTION_LANE_KEY = 'ssh-connection'
const UNATTRIBUTED_REMOTE_LANE_KEY = 'remote-runtime'
const HOST_LANE_KEY = 'host'
const WSL_LANE_PREFIX = 'wsl:'

export function isLocalCodexSelectionLaneKey(laneKey: string): boolean {
  return laneKey === HOST_LANE_KEY || laneKey.startsWith(WSL_LANE_PREFIX)
}

/** Spawn-assigned remote:/ssh: IDs prove foreign ownership without store access; skip pointless 15s inspections early. */
export function isForeignMachineCodexPtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

export function getCodexAccountSwitchLaneMatcher(args: {
  /** Host whose roster the mutation wrote. */
  owner: RuntimeClientTarget
  target?: CodexAccountSelectionTarget | null
  /** Match all WSL lanes only when null-account, distro-less selection clears every slot; other writes must not mute sibling distros. */
  clearsEveryWslDistro?: boolean
}): (laneKey: string) => boolean {
  const runtimeTarget = args.owner
  // Server-owned mutations leave local settings untouched; local host/WSL panes cannot be affected.
  if (runtimeTarget.kind === 'environment') {
    const environmentLaneKey = `${RUNTIME_ENVIRONMENT_LANE_PREFIX}${runtimeTarget.environmentId}`
    return (laneKey) => laneKey === environmentLaneKey
  }
  const normalized = normalizeCodexAccountSelectionTarget(args.target)
  // Distro-less clearing nulls all WSL slots, so match the whole family rather than only __default__.
  if (args.clearsEveryWslDistro && normalized.runtime === 'wsl' && normalized.wslDistro === null) {
    return (laneKey) => laneKey.startsWith(WSL_LANE_PREFIX)
  }
  const switchLaneKey = getCodexSelectionLaneKey(normalized)
  return (laneKey) => laneKey === switchLaneKey
}

export type CodexPaneSelectionLane = {
  laneKey: string
  /** Which answer won: main's spawn-time record, or the renderer's re-derivation. */
  source: 'recorded' | 'derived'
  /** What the derivation said, or null when it threw. Diagnostics only. */
  derivedLaneKey: string | null
}

/** Prefer main’s immutable spawn lane; current runtime preferences can drift and cause missed notices or mute healthy panes. Derive only for older/unrecorded spawns. */
export function resolveCodexPaneSelectionLane(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
  ptyId: string
  /** The pane's `selectionKey` from the on-disk registry, when it has one. */
  recordedLaneKey?: string | null
}): CodexPaneSelectionLane {
  const recorded = args.recordedLaneKey?.trim()
  // Validate persisted local lanes; foreign IDs derive directly because registry hits there imply recycled IDs.
  const trustsRecord =
    Boolean(recorded) &&
    isLocalCodexSelectionLaneKey(recorded as string) &&
    !isForeignMachineCodexPtyId(args.ptyId)
  if (!trustsRecord) {
    const laneKey = resolveCodexPaneSelectionLaneKey(args)
    return { laneKey, source: 'derived', derivedLaneKey: laneKey }
  }
  const derivedLaneKey = deriveLaneKeyForDiagnostics(args)
  if (derivedLaneKey !== null && derivedLaneKey !== recorded) {
    // Report divergence: the authoritative record otherwise hides bugs in fallback derivation.
    console.warn('[codex-lane] recorded launch lane disagrees with the derived one:', {
      ptyId: args.ptyId,
      recorded,
      derived: derivedLaneKey
    })
  }
  return { laneKey: recorded as string, source: 'recorded', derivedLaneKey }
}

/** Never let the diagnostic derivation break a pane whose lane is already known. */
function deriveLaneKeyForDiagnostics(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
  ptyId: string
}): string | null {
  try {
    return resolveCodexPaneSelectionLaneKey(args)
  } catch {
    return null
  }
}

export function resolveCodexPaneSelectionLaneKey(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
  ptyId: string
}): string {
  const remoteParts = parseRemoteRuntimePtyId(args.ptyId)
  if (remoteParts !== null) {
    // Why: mirror inspectRuntimeTerminalProcess — an owner-less remote id reaches no server.
    const environmentId = remoteParts.environmentId?.trim()
    if (!environmentId) {
      return UNATTRIBUTED_REMOTE_LANE_KEY
    }
    // A WSL host's Codex home is this desktop's selection for its distro (the accounts shim).
    const wslHostDistro = wslHostDistroForTarget(
      { kind: 'environment', environmentId },
      args.state.runtimeEnvironments ?? []
    )
    return wslHostDistro
      ? getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: wslHostDistro })
      : `${RUNTIME_ENVIRONMENT_LANE_PREFIX}${environmentId}`
  }
  if (parseAppSshPtyId(args.ptyId) !== null) {
    return SSH_CONNECTION_LANE_KEY
  }
  return getCodexSelectionLaneKey(resolveLocalPaneSelectionTarget(args))
}

/** Mirror main using actual pane startup cwd, which can leave the worktree (#7685); root-based inference can mislabel a live WSL pane host. */
function resolveLocalPaneSelectionTarget(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
}): CodexAccountSelectionTarget {
  const paneCwd = resolvePaneCwd(args)
  const wslPath = paneCwd ? parseWslUncPath(paneCwd) : null
  if (wslPath) {
    return { runtime: 'wsl', wslDistro: wslPath.distro }
  }
  const terminalRuntime = resolveLocalPaneTerminalRuntime(args)
  if (isWslShellName(terminalRuntime.shellOverride)) {
    return { runtime: 'wsl', wslDistro: terminalRuntime.terminalWindowsWslDistro }
  }
  return { runtime: 'host' }
}

function resolvePaneCwd(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'startupCwd' | 'worktreeId'>
}): string | null {
  // Floating cwd is IPC-only, so fall back to shell; a WSL UNC cwd under a host shell remains unknown rather than risking muting a healthy pane.
  if (args.tab.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const workspacePath = getWorkspacePath(args.state, args.tab.worktreeId)
  if (!workspacePath) {
    return null
  }
  // Use main’s resolver so relative/inherited startup folders produce the same absolute cwd.
  return resolveTerminalStartupCwd(workspacePath, args.tab.startupCwd) ?? workspacePath
}

/** Use the same project-runtime resolver the renderer sends with spawn; manual derivation can miss inherited global WSL and mislabel it host. */
function resolveLocalPaneTerminalRuntime(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
}): LocalWindowsTerminalRuntimeOptions {
  // Only win32 spawns consult Windows runtime settings; other platforms use the tab override alone.
  if (getRendererAppPlatform() !== 'win32') {
    return { shellOverride: args.tab.shellOverride, terminalWindowsWslDistro: null }
  }
  const capabilities = hasCachedWindowsTerminalCapabilities()
    ? getCachedWindowsTerminalCapabilities()
    : null
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    args.state,
    args.tab.worktreeId,
    undefined,
    {
      wslAvailable: capabilities?.wslAvailable,
      availableWslDistros: capabilities?.wslDistros ?? null
    }
  )
  if (projectRuntime?.status === 'repair-required') {
    // Handle repair-required before the throwing resolver; this call is outside per-pane guards and must not reject the batch.
    return {
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: projectRuntime.repair.preferredRuntime.distro
    }
  }
  return resolveLocalWindowsTerminalRuntimeOptions({
    requestedShellOverride: args.tab.shellOverride,
    settings: args.state.settings ?? undefined,
    projectRuntime
  })
}

function getWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    return (
      (selectFolderWorkspaces(state) ?? []).find(
        (workspace) => workspace.id === parsed.folderWorkspaceId
      )?.folderPath ?? null
    )
  }
  return (
    Object.values(selectWorktreesByRepo(state) ?? {})
      .flat()
      .find((entry) => entry.id === worktreeId)?.path ?? null
  )
}
