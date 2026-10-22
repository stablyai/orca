// Test-only (never imported by production code): the window-lane launch parity table for row 8
// (an agent started together with its workspace: a work item's "start agent", the folder-workspace
// composer). Renderer suites assert the real producer + pane send `request`; main suites feed it to
// pty:spawn and assert `provider`. C4 moves these launchers onto the pane trigger: the request then
// carries the launch instead of a command, and every provider fact here must hold unchanged.
import type {
  LaunchClient,
  LaunchWorkspace,
  WindowLaunchCase,
  WindowLaunchProducer,
  WindowProviderFacts,
  WindowRequestFacts
} from './launch-parity-window-request.test-fixture'
import { POSIX_PATH, WIN_PATH } from './launch-parity-window-cases.test-fixture'

const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const CMD_CLAUDE = `claude "${SKIP}"`
const POSIX_CODEX = "codex '--dangerously-bypass-approvals-and-sandbox'"
const BOB = "fix Bob's bug"
// Longer than one typed line can safely hold, and multi-line: main's window still puts it on argv.
const LONG_NOTE = `${'Read the failing test output and fix the cause. '.repeat(12)}\nThen run it again.`

const ZSH = { shellOverride: '/bin/zsh' }
const IN_CMD = {
  shellOverride: 'cmd.exe',
  projectRuntime: { kind: 'windows-host', reason: 'global-default' }
} as const
const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
const IN_WSL = {
  shellOverride: 'wsl.exe',
  projectRuntime: { kind: 'wsl', reason: 'project-override', distro: 'Ubuntu' }
} as const
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const CMD = { terminalWindowsShell: 'cmd.exe' }

const repo = (path: string, extra: Partial<LaunchWorkspace> = {}): LaunchWorkspace => ({
  kind: 'repo',
  path,
  ...extra
})
const folder = (path: string): LaunchWorkspace => ({ kind: 'folder', path })
const draft = { kind: 'work-item', agent: 'claude', delivery: 'draft', text: BOB } as const
const note = (text: string): WindowLaunchProducer => ({
  kind: 'folder-composer',
  agent: 'claude',
  note: text
})

function start(
  name: string,
  client: LaunchClient,
  workspace: LaunchWorkspace,
  producer: WindowLaunchProducer,
  request: WindowRequestFacts,
  provider: WindowProviderFacts,
  settings?: Record<string, unknown>
): WindowLaunchCase {
  return { name, row: 8, client, workspace, producer, request, provider, settings }
}

export const WORKSPACE_START_LAUNCH_CASES: WindowLaunchCase[] = [
  // A work item's context is a draft: Claude takes it on argv.
  start(
    'work item, macOS repo, draft rides argv',
    'darwin',
    repo(POSIX_PATH),
    draft,
    { command: `${POSIX_CLAUDE} --prefill 'fix Bob'"'"'s bug'`, agentCommand: POSIX_CLAUDE },
    ZSH
  ),
  // The work item quotes for the cmd.exe tab it spawns (#27971 passes the local shell).
  start(
    'work item, Windows C: repo, cmd.exe set',
    'win32',
    repo(WIN_PATH),
    draft,
    {
      command: `${CMD_CLAUDE} --prefill "fix Bob's bug"`,
      agentCommand: CMD_CLAUDE,
      ...IN_CMD
    },
    CMD_EXE,
    CMD
  ),
  start(
    'work item, Windows C: repo, project WSL',
    'win32',
    repo(WIN_PATH, { projectRuntime: { kind: 'wsl', distro: 'Ubuntu' } }),
    draft,
    {
      command: `${POSIX_CLAUDE} --prefill 'fix Bob'"'"'s bug'`,
      agentCommand: POSIX_CLAUDE,
      ...IN_WSL
    },
    WSL_EXE,
    CMD
  ),
  // A C: project never set to a runtime, with WSL as the terminal shell: the work item follows the
  // Windows runtime default.
  start(
    'work item, Windows C: repo, terminal shell WSL',
    'win32',
    repo(WIN_PATH),
    draft,
    {
      command: `${POSIX_CLAUDE} --prefill 'fix Bob''s bug'`,
      agentCommand: POSIX_CLAUDE,
      shellOverride: 'powershell.exe',
      projectRuntime: { kind: 'windows-host', reason: 'global-default' }
    },
    { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null },
    { terminalWindowsShell: 'wsl.exe' }
  ),
  // Fix checks submit after the agent is ready: the command carries no prompt, the window pastes it,
  // and main's prompt-less Codex start is typed without waiting for the shell to be ready.
  start(
    'work item, submit after ready',
    'darwin',
    repo(POSIX_PATH),
    { kind: 'work-item', agent: 'codex', delivery: 'submit-after-ready', text: BOB },
    { command: POSIX_CODEX, agentCommand: POSIX_CODEX, shellReady: false },
    ZSH
  ),
  // The composer's note is an auto-submitted prompt on argv.
  start(
    'folder composer, macOS folder, note rides argv',
    'darwin',
    folder(POSIX_PATH),
    note(BOB),
    { command: `${POSIX_CLAUDE} 'fix Bob'"'"'s bug'`, agentCommand: POSIX_CLAUDE },
    ZSH
  ),
  // Unlike the work item, the composer quotes for the Windows shell it runs in.
  start(
    'folder composer, Windows C: folder, cmd.exe set',
    'win32',
    folder(WIN_PATH),
    note(BOB),
    // A folder has no project, so no project runtime is sent.
    {
      command: `${CMD_CLAUDE} "fix Bob's bug"`,
      agentCommand: CMD_CLAUDE,
      shellOverride: 'cmd.exe'
    },
    CMD_EXE,
    CMD
  ),
  // A folder keeps WSL when it is the terminal shell (the host's wslShellRule).
  start(
    'folder composer, Windows C: folder, terminal shell WSL',
    'win32',
    folder(WIN_PATH),
    note(BOB),
    {
      command: `${POSIX_CLAUDE} 'fix Bob'"'"'s bug'`,
      agentCommand: POSIX_CLAUDE,
      shellOverride: 'wsl.exe'
    },
    // main today: the terminal's default distro, none named.
    { shellOverride: 'wsl.exe', terminalWindowsWslDistro: null },
    { terminalWindowsShell: 'wsl.exe' }
  ),
  // main's window carries a prompt on argv at any length, where the host would paste a long one.
  start(
    'folder composer, long multi-line note rides argv',
    'darwin',
    folder(POSIX_PATH),
    note(LONG_NOTE),
    {
      command: `${POSIX_CLAUDE} '${LONG_NOTE}'`,
      agentCommand: POSIX_CLAUDE
    },
    ZSH
  )
]
