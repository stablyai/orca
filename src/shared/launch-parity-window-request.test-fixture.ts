// Test-only (never imported by production code): turns a window-lane parity case into the exact
// pty:spawn request a real pane sends, with fixed ids so renderer and main compare the same bytes.
import type { LocalWindowsRuntimePreference } from './project-execution-runtime'

export type LaunchClient = 'darwin' | 'linux' | 'win32'
export const LAUNCH_REPO_ID = 'repo-1'
export const LAUNCH_FOLDER_ID = 'folder:fw-1'
export const LAUNCH_TAB_ID = 'tab-parity'
// The pane fixture's first leaf (pty-connection-test-pane-fixtures.ts).
export const LAUNCH_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const LAUNCH_TOKEN = 'launch-token-parity'
/** The window pane's measured grid: no lane defaults to it, so it shows the pane size reached the provider. */
export const PANE_GRID = { cols: 97, rows: 31 } as const

export type LaunchWorkspace = {
  kind: 'repo' | 'folder'
  path: string
  /** SSH target id; absent = local. */
  connectionId?: string
  /** The project's saved Windows runtime; absent = never saved. */
  projectRuntime?: LocalWindowsRuntimePreference
  /** Folder workspaces only: a local repo at this path, to show which repos a folder borrows. */
  repoPath?: string
  /** A paired runtime environment that owns the worktree. */
  pairedRuntime?: string
}

export function launchWorkspaceId(workspace: LaunchWorkspace): string {
  return workspace.kind === 'folder' ? LAUNCH_FOLDER_ID : `${LAUNCH_REPO_ID}::${workspace.path}`
}

export type WindowLaunchProducer =
  | {
      kind: 'new-tab'
      agent: 'claude' | 'codex' | 'aider'
      prompt: string
      delivery: 'draft' | 'auto-submit'
      launchSource: 'quick_command'
      initialCwd?: string
    }
  | { kind: 'transcript-continue'; transcript: string; cwd: string | null }

type ProjectRuntimeSent =
  | { kind: 'windows-host'; reason: 'global-default' | 'project-override' }
  | { kind: 'wsl'; reason: 'global-default' | 'project-override'; distro: string }

/** What the pane sends (renderer half). Unset fields take the defaults in windowSpawnRequest. */
export type WindowRequestFacts = {
  command: string
  agentCommand: string
  shellOverride?: string
  projectRuntime?: ProjectRuntimeSent
  cwd?: string
  /** The agent's saved default env, sent in the pane env and the launch config. */
  agentEnv?: Record<string, string>
}

/** What reaches the provider for that request (main half). */
export type WindowProviderFacts = {
  shellOverride: string | undefined
  terminalWindowsWslDistro?: string | null
}

export type WindowLaunchCase = {
  name: string
  /** The launch-convergence producer row. */
  row: 2 | 6
  client: LaunchClient
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  producer: WindowLaunchProducer
  request: WindowRequestFacts
  provider: WindowProviderFacts
}

const AGENT_ARGS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  aider: '--yes-always',
  antigravity: '--dangerously-skip-permissions'
} as const

function sentRuntime(runtime: ProjectRuntimeSent): Record<string, unknown> {
  const base = { projectId: LAUNCH_REPO_ID, reason: runtime.reason }
  return {
    status: 'resolved',
    runtime:
      runtime.kind === 'wsl'
        ? {
            ...base,
            kind: 'wsl',
            hostPlatform: 'wsl',
            distro: runtime.distro,
            cacheKey: `${LAUNCH_REPO_ID}:wsl:${runtime.distro}`
          }
        : {
            ...base,
            kind: 'windows-host',
            hostPlatform: 'win32',
            cacheKey: `${LAUNCH_REPO_ID}:windows-host`
          }
  }
}

/** The full pty:spawn request a real pane sends for this case. */
export function windowSpawnRequest(c: WindowLaunchCase): Record<string, unknown> {
  const { workspace, producer, request } = c
  const worktreeId = launchWorkspaceId(workspace)
  const ssh = workspace.connectionId !== undefined
  const agent = producer.kind === 'new-tab' ? producer.agent : 'antigravity'
  const cwd = request.cwd ?? workspace.path
  // A local Windows ConPTY pane withholds the kitty keyboard flag (terminal-keyboard-protocol.ts).
  const localConpty =
    c.client === 'win32' &&
    !ssh &&
    request.shellOverride !== 'wsl.exe' &&
    !cwd.startsWith('\\\\wsl')
  return {
    ...PANE_GRID,
    cwd,
    ...(ssh ? {} : { cwdFallback: 'worktree' }),
    env: {
      ...request.agentEnv,
      ORCA_WORKSPACE_ID: worktreeId,
      ...(workspace.kind === 'folder'
        ? { ORCA_PROJECT_GROUP_ID: 'pg-1', ORCA_WORKSPACE_ROOT: workspace.path }
        : {}),
      ORCA_PANE_KEY: `${LAUNCH_TAB_ID}:${LAUNCH_LEAF_ID}`,
      ORCA_TAB_ID: LAUNCH_TAB_ID,
      ORCA_WORKTREE_ID: worktreeId,
      ORCA_AGENT_LAUNCH_TOKEN: LAUNCH_TOKEN
    },
    command: request.command,
    launchConfig: {
      agentCommand: request.agentCommand,
      agentArgs: AGENT_ARGS[agent],
      agentEnv: request.agentEnv ?? {}
    },
    launchToken: LAUNCH_TOKEN,
    launchAgent: agent,
    ...(ssh
      ? { commandDelivery: 'provider', startupCommandDelivery: 'shell-ready' }
      : agent === 'codex'
        ? { startupCommandDelivery: 'shell-ready' }
        : {}),
    ...(ssh ? { connectionId: workspace.connectionId } : {}),
    worktreeId,
    tabId: LAUNCH_TAB_ID,
    leafId: LAUNCH_LEAF_ID,
    ...(request.shellOverride ? { shellOverride: request.shellOverride } : {}),
    ...(request.projectRuntime ? { projectRuntime: sentRuntime(request.projectRuntime) } : {}),
    ...(localConpty ? {} : { terminalKittyKeyboardProtocol: true }),
    telemetry:
      producer.kind === 'new-tab'
        ? {
            agent_kind: agent === 'claude' ? 'claude-code' : agent,
            launch_source: producer.launchSource,
            request_kind: 'new'
          }
        : { agent_kind: 'antigravity', launch_source: 'sidebar', request_kind: 'resume' }
  }
}

// The pane identity keys the plan names; agent hook and CLI keys vary by host and are not launch facts.
export const IDENTITY_ENV_KEYS = [
  'ORCA_WORKSPACE_ID',
  'ORCA_PROJECT_GROUP_ID',
  'ORCA_WORKSPACE_ROOT',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_TERMINAL_HANDLE'
] as const

/** What main hands the provider for a window-lane pty:spawn request (rows 2, 5 and 6). */
export function expectedWindowProvider(
  request: Record<string, unknown>,
  provider: WindowProviderFacts,
  agentEnv: Record<string, string>
): Record<string, unknown> {
  // main adds the terminal handle to the pane's env.
  const env = { ...(typeof request.env === 'object' ? request.env : {}), ORCA_TERMINAL_HANDLE: '' }
  return {
    command: request.command,
    // main normalizes the cwd to forward slashes (resolveRuntimePath).
    cwd: String(request.cwd).replaceAll('\\', '/'),
    // The pane's measured size, and never marked hidden before its pane shows.
    cols: request.cols,
    rows: request.rows,
    hidden: false,
    env: agentEnv,
    ...provider,
    ...(request.commandDelivery ? { commandDelivery: request.commandDelivery } : {}),
    ...(request.startupCommandDelivery
      ? { startupCommandDelivery: request.startupCommandDelivery }
      : {}),
    orcaEnv: IDENTITY_ENV_KEYS.filter((key) => key in env)
  }
}
