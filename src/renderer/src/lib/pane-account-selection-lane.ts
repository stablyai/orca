import type { AppState } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
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
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getWorkspacePath } from './workspace-directory'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { getRendererAppPlatform } from './renderer-app-platform'
import { wslHostDistroForTarget } from './wsl-host-account-owner'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from './windows-terminal-capabilities'

/** Everything the pane lane needs: the workspace path plus the project runtime inputs. */
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

/**
 * Lane keys for panes whose Codex credentials come from another machine.
 *
 * Why they need keys at all: a managed Codex account is scoped to one machine
 * AND one runtime (`host` or `wsl:<distro>`). A relay environment keeps its own
 * account roster, and an SSH connection has no Orca-managed selection whatsoever
 * — the remote Codex reads that machine's own credentials. Neither can be
 * stranded by a local selection change, so they must not share the local keys.
 */
const RUNTIME_ENVIRONMENT_LANE_PREFIX = 'env:'
const SSH_CONNECTION_LANE_KEY = 'ssh-connection'
const UNATTRIBUTED_REMOTE_LANE_KEY = 'remote-runtime'
const WSL_LANE_PREFIX = 'wsl:'

/**
 * True when the pane's shell runs on a machine other than this one.
 *
 * Why it takes only the id: a `remote:`/`ssh:` prefix is assigned at spawn and
 * is decisive on its own, so a caller can decide without store access.
 */
export function isForeignMachinePtyId(ptyId: string): boolean {
  return parseRemoteRuntimePtyId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

/** Matches the panes a Codex account mutation could have re-pointed. */
export function getAccountSwitchLaneMatcher(args: {
  /** Host whose roster the mutation wrote. */
  owner: RuntimeClientTarget
  target?: CodexAccountSelectionTarget | null
  /**
   * True only when the mutation cleared every WSL distro slot at once, which
   * setSelectedCodexAccountIdForTarget does for a null account on a distro-less
   * WSL target. Any other write lands in a single slot, so defaulting this to
   * false keeps the matcher off a sibling distro's healthy panes.
   */
  clearsEveryWslDistro?: boolean
}): (laneKey: string) => boolean {
  const runtimeTarget = args.owner
  // Why: a server-owned mutation is RPC'd to that machine's
  // roster and local GlobalSettings are never touched, so the local host/WSL
  // panes are exactly the ones the switch cannot have affected.
  if (runtimeTarget.kind === 'environment') {
    const environmentLaneKey = `${RUNTIME_ENVIRONMENT_LANE_PREFIX}${runtimeTarget.environmentId}`
    return (laneKey) => laneKey === environmentLaneKey
  }
  const normalized = normalizeCodexAccountSelectionTarget(args.target)
  // Why a family rather than the `wsl:__default__` key: clearing a distro-less
  // WSL selection nulls every distro slot, so every WSL pane really is stranded.
  // Keying that to `__default__` alone would leave them all unasked.
  if (args.clearsEveryWslDistro && normalized.runtime === 'wsl' && normalized.wslDistro === null) {
    return (laneKey) => laneKey.startsWith(WSL_LANE_PREFIX)
  }
  const switchLaneKey = getCodexSelectionLaneKey(normalized)
  return (laneKey) => laneKey === switchLaneKey
}

/** The account-selection lane a live pane launches its agent from, derived from state. */
export function resolvePaneAccountSelectionLaneKey(args: {
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

/**
 * Mirrors the main-process getCodexSelectionTargetForPty, from renderer state.
 *
 * Why the pane cwd and not the workspace root: a terminal's startup cwd is
 * deliberately NOT constrained to the worktree (see resolveTerminalStartupCwd,
 * #7685), so a pane split after `cd \\wsl.localhost\...` runs on a different
 * filesystem than its workspace. Main keys the lane off that cwd, so reading the
 * root instead would call a live WSL pane `host` and ask about it on a host switch.
 */
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

/** The absolute directory the pane's shell was spawned in, as main resolved it. */
function resolvePaneCwd(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'startupCwd' | 'worktreeId'>
}): string | null {
  // Why floating terminals get no cwd: theirs never reaches the tab. It is
  // resolved over IPC from settings.floatingTerminalCwd and handed to the
  // transport as a prop, so the store cannot see the path main keyed off. Such a
  // pane falls through to its shell below, which is right unless the configured
  // floating cwd is a WSL UNC path under a host shell — a known gap, not a guess
  // worth making, since guessing wrong here offers to restart a working terminal.
  if (args.tab.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const workspacePath = getWorkspacePath(args.state, args.tab.worktreeId)
  if (!workspacePath) {
    return null
  }
  // Why this exact call: it is the same one main spawns through, so a relative
  // or inherited startup folder resolves to the identical absolute path.
  return resolveTerminalStartupCwd(workspacePath, args.tab.startupCwd) ?? workspacePath
}

/**
 * The shell and distro the launch resolved, not merely the ones the tab asked for.
 *
 * Why getLocalProjectExecutionRuntimeContext specifically: for a local pane the
 * RENDERER computes the project runtime and ships it with the spawn
 * (pty-connection.ts), so this is not an approximation of main — it is the same
 * call on the same state. Re-deriving it by hand drops the global WSL default,
 * which turns `inherit-global` into WSL and would key a live WSL pane `host`.
 */
function resolveLocalPaneTerminalRuntime(args: {
  state: CodexPaneLaneState
  tab: Pick<TerminalTab, 'shellOverride' | 'startupCwd' | 'worktreeId'>
}): LocalWindowsTerminalRuntimeOptions {
  // Why the platform gate: pty.ts only consults the Windows terminal runtime on
  // win32, so elsewhere the tab's own override is the whole answer.
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
    // Why not delegate: resolveLocalWindowsTerminalRuntimeOptions throws here,
    // and this call sits outside the scan's per-pane failure guard, so a throw
    // would lose the question for every pane in the batch, not just this one.
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
