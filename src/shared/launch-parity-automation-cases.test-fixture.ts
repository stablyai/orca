// Test-only (never imported by production code): the row 5 desktop-automation parity table.
// Renderer suites assert launchAgentBackgroundSession sends `request`; main suites feed the
// same pty:spawn request and assert `provider`.
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  launchWorkspaceId,
  type LaunchClient,
  type LaunchWorkspace,
  type WindowProviderFacts
} from './launch-parity-window-request.test-fixture'
import { POSIX_PATH, WIN_PATH, WSL_PATH } from './launch-parity-window-cases.test-fixture'

export type AutomationLaunchCase = {
  name: string
  client: LaunchClient
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  agent: 'claude' | 'codex' | 'aider'
  title?: string
  request: { command: string; agentCommand: string; shellOverride?: string }
  provider: WindowProviderFacts
}

// Why an apostrophe: it is the byte that tells POSIX, PowerShell and cmd quoting apart.
export const AUTOMATION_PROMPT = "don't stop"
const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const posix = { command: `${POSIX_CLAUDE} 'don'"'"'t stop'`, agentCommand: POSIX_CLAUDE }
const powershell = { command: `${POSIX_CLAUDE} 'don''t stop'`, agentCommand: POSIX_CLAUDE }
const ZSH = { shellOverride: '/bin/zsh' }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const ssh = { connectionId: 'ssh-1' }
const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
const folder = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'folder',
  path,
  ...extra
})
type AutomationCaseFields = Omit<AutomationLaunchCase, 'name' | 'agent' | 'title'> &
  Partial<Pick<AutomationLaunchCase, 'agent' | 'title'>>
const automation = (name: string, fields: AutomationCaseFields): AutomationLaunchCase => ({
  name,
  agent: 'claude',
  title: 'Nightly audit',
  ...fields
})

// AUTOMATION_WSL_EXE: only a local \\wsl$ workspace sends a shellOverride. Automations quote a
// folder by its own path (the background launch-host rule), not by the window planner's rule.
export const AUTOMATION_LAUNCH_CASES: AutomationLaunchCase[] = [
  automation('macOS repo', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  automation('macOS folder', {
    client: 'darwin',
    workspace: folder(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  automation('Windows C: repo, default PowerShell', {
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: powershell,
    provider: PWSH
  }),
  automation('Windows C: repo, cmd.exe', {
    client: 'win32',
    workspace: repo(WIN_PATH),
    settings: { terminalWindowsShell: 'cmd.exe' },
    request: { command: `claude "${SKIP}" "don't stop"`, agentCommand: `claude "${SKIP}"` },
    provider: { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
  }),
  // main today: quoted for WSL, yet no shellOverride or projectRuntime, so main runs the settings shell.
  automation('Windows C: repo, project WSL', {
    client: 'win32',
    workspace: repo(WIN_PATH, { projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } }),
    request: posix,
    provider: PWSH
  }),
  automation('Windows wsl$ repo, no saved runtime', {
    client: 'win32',
    workspace: repo(WSL_PATH),
    request: { ...posix, shellOverride: 'wsl.exe' },
    provider: WSL_EXE
  }),
  // Only the Settings UI saves inherit-global; it quotes for Windows and still runs wsl.exe.
  automation('Windows wsl$ repo, saved inherit-global', {
    client: 'win32',
    workspace: repo(WSL_PATH, { projectRuntime: { kind: 'inherit-global' } }),
    request: { ...powershell, shellOverride: 'wsl.exe' },
    provider: WSL_EXE
  }),
  automation('Windows C: folder', {
    client: 'win32',
    workspace: folder(WIN_PATH),
    request: powershell,
    provider: PWSH
  }),
  automation('Windows wsl$ folder', {
    client: 'win32',
    workspace: folder(WSL_PATH),
    request: { ...posix, shellOverride: 'wsl.exe' },
    provider: WSL_EXE
  }),
  automation('Windows client, SSH repo', {
    client: 'win32',
    workspace: repo(POSIX_PATH, ssh),
    request: posix,
    provider: ZSH
  }),
  automation('macOS client, SSH Windows-path repo', {
    client: 'darwin',
    workspace: repo(WIN_PATH, ssh),
    request: powershell,
    provider: ZSH
  }),
  automation('macOS client, SSH Windows-path folder', {
    client: 'darwin',
    workspace: folder(WIN_PATH, ssh),
    request: powershell,
    provider: ZSH
  }),
  // main today: no disabled-agent check on this route.
  automation('Linux repo, claude disabled in settings', {
    client: 'linux',
    workspace: repo(POSIX_PATH),
    settings: { disabledTuiAgents: ['claude'] },
    request: posix,
    provider: ZSH
  }),
  automation('Linux client, SSH repo, claude disabled', {
    client: 'linux',
    workspace: repo(POSIX_PATH, ssh),
    settings: { disabledTuiAgents: ['claude'] },
    request: posix,
    provider: ZSH
  }),
  automation('Linux repo, codex, no title', {
    client: 'linux',
    agent: 'codex',
    title: undefined,
    workspace: repo(POSIX_PATH),
    request: {
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'don'"'"'t stop'`,
      agentCommand: `codex '--dangerously-bypass-approvals-and-sandbox'`
    },
    provider: ZSH
  }),
  // stdin-after-start: the prompt is pasted after launch, never on argv.
  automation('Linux repo, aider', {
    client: 'linux',
    agent: 'aider',
    workspace: repo(POSIX_PATH),
    request: { command: "aider '--yes-always'", agentCommand: "aider '--yes-always'" },
    provider: ZSH
  })
]

const AGENT_KIND = { claude: 'claude-code', codex: 'codex', aider: 'aider' } as const
const AGENT_ARGS = {
  claude: SKIP,
  codex: '--dangerously-bypass-approvals-and-sandbox',
  aider: '--yes-always'
} as const

/** The full pty:spawn request launchAgentBackgroundSession sends for this case. */
export function automationSpawnRequest(c: AutomationLaunchCase): Record<string, unknown> {
  const worktreeId = launchWorkspaceId(c.workspace)
  const connectionId = c.workspace.connectionId ?? null
  return {
    cols: 120,
    rows: 40,
    cwd: c.workspace.path,
    command: c.request.command,
    ...(c.request.shellOverride ? { shellOverride: c.request.shellOverride } : {}),
    ...(connectionId
      ? { commandDelivery: 'provider', startupCommandDelivery: 'shell-ready' }
      : c.agent === 'codex'
        ? { startupCommandDelivery: 'shell-ready' }
        : {}),
    env: {
      ORCA_PANE_KEY: `${LAUNCH_TAB_ID}:${LAUNCH_LEAF_ID}`,
      ORCA_TAB_ID: LAUNCH_TAB_ID,
      ORCA_WORKTREE_ID: worktreeId,
      ORCA_AGENT_LAUNCH_TOKEN: LAUNCH_TOKEN
    },
    launchConfig: {
      agentCommand: c.request.agentCommand,
      agentArgs: AGENT_ARGS[c.agent],
      agentEnv: {}
    },
    launchToken: LAUNCH_TOKEN,
    launchAgent: c.agent,
    connectionId,
    worktreeId,
    tabId: LAUNCH_TAB_ID,
    leafId: LAUNCH_LEAF_ID,
    placement: { kind: 'new-tab', ...(c.title ? { row: { customTitle: c.title } } : {}) },
    telemetry: { agent_kind: AGENT_KIND[c.agent], launch_source: 'unknown', request_kind: 'new' }
  }
}
