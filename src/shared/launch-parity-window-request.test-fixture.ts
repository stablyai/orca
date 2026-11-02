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
  /** The project's saved Windows runtime; absent = never saved. */
  projectRuntime?: LocalWindowsRuntimePreference
  /** Folder workspaces only: a local repo at this path, to show which repos a folder borrows. */
  repoPath?: string
}

export function launchWorkspaceId(workspace: LaunchWorkspace): string {
  return workspace.kind === 'folder' ? LAUNCH_FOLDER_ID : `${LAUNCH_REPO_ID}::${workspace.path}`
}

export type WindowLaunchProducer =
  /** An agent-prompt quick command (run-quick-command-in-new-tab.ts): Claude and Codex auto-submit. */
  | { kind: 'quick-command'; agent: 'claude' | 'codex'; prompt: string }
  /** A terminal's "continue in new session": Claude gets a draft in the pane's cwd. */
  | { kind: 'continuation'; agent: 'claude'; prompt: string; initialCwd: string }
  | { kind: 'transcript-continue'; transcript: string; cwd: string | null }
  /** A "+" launch with no prompt, as each "+" entry point calls launchAgentInNewTab. */
  | { kind: 'plus'; agent: 'claude'; via: PlusEntry }
  /** A work item's "start agent" (launch-work-item-direct.ts): the workspace and its agent at once. */
  | {
      kind: 'work-item'
      agent: 'claude' | 'codex'
      delivery: 'draft' | 'submit-after-ready'
      text: string
    }
  /** The folder-workspace composer's create with an agent; the note is its prompt. */
  | { kind: 'folder-composer'; agent: 'claude' | 'codex'; note: string }

/** "+" entry points. Quick Launch items omit launchSource and get `menu`'s source by default. */
export type PlusEntry = 'menu' | 'shortcut' | 'dashboard'
const PRODUCER_LAUNCH_SOURCE = {
  'quick-command': 'quick_command',
  continuation: 'terminal_context_menu',
  'work-item': 'task_page',
  'folder-composer': 'new_workspace_composer'
} as const
const PLUS_LAUNCH_SOURCE: Record<PlusEntry, string> = {
  menu: 'tab_bar_quick_launch',
  shortcut: 'shortcut',
  dashboard: 'unknown'
}

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
  /** The agent's saved default args; absent = the settings default. */
  agentArgs?: string
  /** Whether the command waits for the shell to be ready; absent = only Codex does. */
  shellReady?: boolean
}

/** What reaches the provider for that request (main half). */
export type WindowProviderFacts = {
  /** Default: the request's command. */
  command?: string
  shellOverride: string | undefined
  terminalWindowsWslDistro?: string | null
}

export type WindowLaunchCase = {
  name: string
  /** The launch-convergence producer row. */
  row: 1 | 2 | 6 | 8
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
  const agent = producer.kind === 'transcript-continue' ? 'antigravity' : producer.agent
  const cwd = request.cwd ?? workspace.path
  // A local Windows ConPTY pane withholds the kitty keyboard flag (terminal-keyboard-protocol.ts).
  const localConpty =
    c.client === 'win32' && request.shellOverride !== 'wsl.exe' && !cwd.startsWith('\\\\wsl')
  return {
    ...PANE_GRID,
    cwd,
    cwdFallback: 'worktree',
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
      agentArgs: request.agentArgs ?? AGENT_ARGS[agent],
      agentEnv: request.agentEnv ?? {}
    },
    launchToken: LAUNCH_TOKEN,
    launchAgent: agent,
    ...((request.shellReady ?? agent === 'codex') ? { startupCommandDelivery: 'shell-ready' } : {}),
    worktreeId,
    tabId: LAUNCH_TAB_ID,
    leafId: LAUNCH_LEAF_ID,
    ...(request.shellOverride ? { shellOverride: request.shellOverride } : {}),
    ...(request.projectRuntime ? { projectRuntime: sentRuntime(request.projectRuntime) } : {}),
    ...(localConpty ? {} : { terminalKittyKeyboardProtocol: true }),
    telemetry:
      producer.kind === 'transcript-continue'
        ? { agent_kind: 'antigravity', launch_source: 'sidebar', request_kind: 'resume' }
        : {
            agent_kind: agent === 'claude' ? 'claude-code' : agent,
            launch_source:
              producer.kind === 'plus'
                ? PLUS_LAUNCH_SOURCE[producer.via]
                : PRODUCER_LAUNCH_SOURCE[producer.kind],
            request_kind: 'new'
          }
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
    command: provider.command ?? request.command,
    // main normalizes the cwd to forward slashes (resolveRuntimePath).
    cwd: String(request.cwd).replaceAll('\\', '/'),
    // The pane's measured size, and never marked hidden before its pane shows.
    cols: request.cols,
    rows: request.rows,
    hidden: false,
    env: agentEnv,
    ...provider,
    ...(request.startupCommandDelivery
      ? { startupCommandDelivery: request.startupCommandDelivery }
      : {}),
    orcaEnv: IDENTITY_ENV_KEYS.filter((key) => key in env)
  }
}
