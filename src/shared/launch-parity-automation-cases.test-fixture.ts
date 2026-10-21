// Test-only (never imported by production code): the row 5 desktop-automation parity table.
// The renderer suite asserts launchAgentBackgroundSession sends `request`; the main suite feeds the
// same request to pty:spawn. C7 (automations onto agent.launch) and C5 check against it.
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
  /** The run title; every dispatch passes "<automation name> run <n>". */
  title: string
  request: { command: string; agentCommand: string; shellOverride?: string }
  provider: WindowProviderFacts
}

// Why an apostrophe: it is the byte that tells POSIX and PowerShell quoting apart.
export const AUTOMATION_PROMPT = "don't stop"
const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const posix = { command: `${POSIX_CLAUDE} 'don'"'"'t stop'`, agentCommand: POSIX_CLAUDE }
const powershell = { command: `${POSIX_CLAUDE} 'don''t stop'`, agentCommand: POSIX_CLAUDE }
const CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"
const AGENT_COMMAND = {
  codex: { command: `${CODEX} 'don'"'"'t stop'`, agentCommand: CODEX },
  aider: { command: "aider '--yes-always'", agentCommand: "aider '--yes-always'" }
} as const
const ZSH = { shellOverride: '/bin/zsh' }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const repo = (path: string): LaunchWorkspace => ({ kind: 'repo', path })
type AutomationCaseFields = Omit<AutomationLaunchCase, 'name' | 'agent' | 'title'> &
  Partial<Pick<AutomationLaunchCase, 'agent'>>
const automation = (name: string, fields: AutomationCaseFields): AutomationLaunchCase => ({
  name,
  agent: 'claude',
  title: 'Nightly audit run 3',
  ...fields
})

// Only a local \\wsl$ workspace sends a shellOverride. Quoting follows the execution host's OS, the
// same rule a window tab uses; the shell does not.
export const AUTOMATION_LAUNCH_CASES: AutomationLaunchCase[] = [
  automation('macOS repo', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  automation('Windows C: repo, default PowerShell', {
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: powershell,
    provider: PWSH
  }),
  automation('Windows wsl$ repo, no saved runtime', {
    client: 'win32',
    workspace: repo(WSL_PATH),
    request: { ...posix, shellOverride: 'wsl.exe' },
    provider: WSL_EXE
  }),
  automation('Linux repo, codex', {
    client: 'linux',
    agent: 'codex',
    workspace: repo(POSIX_PATH),
    request: AGENT_COMMAND.codex,
    provider: ZSH
  }),
  // stdin-after-start: the prompt is pasted after launch, never on argv.
  automation('Linux repo, aider', {
    client: 'linux',
    agent: 'aider',
    workspace: repo(POSIX_PATH),
    request: AGENT_COMMAND.aider,
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
  return {
    cols: 120,
    rows: 40,
    cwd: c.workspace.path,
    command: c.request.command,
    ...(c.request.shellOverride ? { shellOverride: c.request.shellOverride } : {}),
    ...(c.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' } : {}),
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
    connectionId: null,
    worktreeId,
    tabId: LAUNCH_TAB_ID,
    leafId: LAUNCH_LEAF_ID,
    placement: { kind: 'new-tab', row: { customTitle: c.title } },
    telemetry: { agent_kind: AGENT_KIND[c.agent], launch_source: 'unknown', request_kind: 'new' }
  }
}

/** The phone's view of a run tab: hidden under its run title, no agent named, active. */
export function automationPhoneTab(
  c: Pick<AutomationLaunchCase, 'title'>
): Record<string, unknown> {
  return { title: c.title, launchAgent: undefined, isActive: true }
}
