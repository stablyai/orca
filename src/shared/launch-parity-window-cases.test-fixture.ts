// Test-only (never imported by production code): the window-lane launch parity table for rows 2
// (typed prompt into a new tab) and 6 (continue from transcript). Renderer suites assert a real
// producer + pane sends `request`; main suites feed it to pty:spawn and assert `provider`.
import type { LaunchWorkspace, WindowLaunchCase } from './launch-parity-window-request.test-fixture'

export const POSIX_PATH = '/home/alice/repo'
export const WIN_PATH = String.raw`C:\Users\alice\repo`
export const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`

const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const CMD_CLAUDE = `claude "${SKIP}"`
// The draft rides --prefill; the apostrophe shows which shell the command was quoted for.
const POSIX_DRAFT = `${POSIX_CLAUDE} --prefill 'fix Bob'"'"'s bug'`
const PS_DRAFT = `${POSIX_CLAUDE} --prefill 'fix Bob''s bug'`
const CMD_DRAFT = `${CMD_CLAUDE} --prefill "fix Bob's bug"`
const posix = { command: POSIX_DRAFT, agentCommand: POSIX_CLAUDE }
const powershell = { command: PS_DRAFT, agentCommand: POSIX_CLAUDE }

const BRAIN = '.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const reference = (path: string): string =>
  `Review the chat transcript at "${path}". Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
const agy = (path: string, bin = 'agy'): { command: string; agentCommand: string } => ({
  command: `${bin} '${SKIP}' --prompt-interactive '${reference(path)}'`,
  agentCommand: `${bin} '${SKIP}'`
})

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
const draft = { kind: 'new-tab', agent: 'claude', delivery: 'draft' } as const
const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
const HOST_GLOBAL = { kind: 'windows-host', reason: 'global-default' } as const
const WSL_PROJECT = { kind: 'wsl', reason: 'project-override', distro: 'Ubuntu' } as const
// Main runs a local pane in the settings shell; Windows adds the WSL distro it derived.
const ZSH = { shellOverride: '/bin/zsh' }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
const CMD = { settings: { terminalWindowsShell: 'cmd.exe' } }

type CaseShape = Pick<WindowLaunchCase, 'client' | 'workspace' | 'request' | 'provider'> &
  Partial<Pick<WindowLaunchCase, 'settings' | 'producer'>>

function launch(row: 2 | 6, name: string, shape: CaseShape): WindowLaunchCase {
  const rules = shape.workspace.connectionId
    ? ['WINDOW_PLANNER', 'IPC_SSH_DEFAULT_SHELL']
    : ['WINDOW_PLANNER', 'WINDOW_PANE']
  return { name, row, rules, producer: draft, ...shape }
}
const typed = (name: string, shape: CaseShape): WindowLaunchCase => launch(2, name, shape)
const resume = (
  name: string,
  transcript: string,
  cwd: string | null,
  shape: CaseShape
): WindowLaunchCase =>
  launch(6, name, { producer: { kind: 'transcript-continue', transcript, cwd }, ...shape })

const MAC_T = `/Users/alice/${BRAIN}`
const WIN_T = `C:/Users/alice/${BRAIN}`
const LINUX_T = `/home/alice/${BRAIN}`
const ALICE = String.raw`C:\Users\alice`

export const WINDOW_LAUNCH_CASES: WindowLaunchCase[] = [
  typed('macOS repo', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  typed('macOS folder', {
    client: 'darwin',
    workspace: folder(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  typed('Linux repo', {
    client: 'linux',
    workspace: repo(POSIX_PATH),
    request: posix,
    provider: ZSH
  }),
  typed('macOS repo, codex auto-submit waits for the shell', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    producer: { kind: 'new-tab', agent: 'codex', delivery: 'auto-submit' },
    request: {
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob'"'"'s bug'`,
      agentCommand: `codex '--dangerously-bypass-approvals-and-sandbox'`
    },
    provider: ZSH
  }),
  typed('macOS repo, initial cwd in a subfolder', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    producer: { ...draft, initialCwd: `${POSIX_PATH}/pkg` },
    request: { ...posix, cwd: `${POSIX_PATH}/pkg` },
    provider: ZSH
  }),
  typed('macOS repo, saved default env', {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    settings: { agentDefaultEnv: { claude: { ANTHROPIC_BASE_URL: 'https://claude.example' } } },
    request: { ...posix, agentEnv: { ANTHROPIC_BASE_URL: 'https://claude.example' } },
    provider: ZSH
  }),
  // stdin-after-start: the prompt is pasted once the agent is ready (launch-agent-in-new-tab tests).
  typed('Linux repo, aider', {
    client: 'linux',
    workspace: repo(POSIX_PATH),
    producer: { kind: 'new-tab', agent: 'aider', delivery: 'auto-submit' },
    request: { command: "aider '--yes-always'", agentCommand: "aider '--yes-always'" },
    provider: ZSH
  }),
  typed('Windows C: repo, default PowerShell', {
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: { ...powershell, shellOverride: 'powershell.exe', projectRuntime: HOST_GLOBAL },
    provider: PWSH
  }),
  typed('Windows C: repo, cmd.exe setting', {
    ...CMD,
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: {
      command: CMD_DRAFT,
      agentCommand: CMD_CLAUDE,
      shellOverride: 'cmd.exe',
      projectRuntime: HOST_GLOBAL
    },
    provider: CMD_EXE
  }),
  // A never-saved \\wsl$ project reads as a WSL project override from its path.
  typed('Windows wsl$ repo, no saved runtime', {
    client: 'win32',
    workspace: repo(WSL_PATH),
    request: { ...posix, shellOverride: 'wsl.exe', projectRuntime: WSL_PROJECT },
    provider: WSL_EXE
  }),
  typed('Windows C: repo, project WSL', {
    client: 'win32',
    workspace: repo(WIN_PATH, { projectRuntime: WSL_UBUNTU }),
    request: { ...posix, shellOverride: 'wsl.exe', projectRuntime: WSL_PROJECT },
    provider: WSL_EXE
  }),
  // main today: the host shell runs, yet main still derives a WSL distro from the \\wsl$ cwd.
  typed('Windows wsl$ repo, project Windows host', {
    client: 'win32',
    workspace: repo(WSL_PATH, { projectRuntime: { kind: 'windows-host' } }),
    request: {
      ...powershell,
      shellOverride: 'powershell.exe',
      projectRuntime: { kind: 'windows-host', reason: 'project-override' }
    },
    provider: { shellOverride: 'powershell.exe', terminalWindowsWslDistro: 'Ubuntu' }
  }),
  typed('Windows C: repo, global default WSL', {
    client: 'win32',
    workspace: repo(WIN_PATH),
    settings: { localWindowsRuntimeDefault: WSL_UBUNTU },
    request: {
      ...posix,
      shellOverride: 'wsl.exe',
      projectRuntime: { ...WSL_PROJECT, reason: 'global-default' }
    },
    provider: WSL_EXE
  }),
  typed('Windows C: folder', {
    client: 'win32',
    workspace: folder(WIN_PATH),
    request: { ...powershell, shellOverride: 'powershell.exe' },
    provider: PWSH
  }),
  // main today: quoted for PowerShell (folder planner) while createTab picks wsl.exe from the path.
  typed('Windows wsl$ folder', {
    client: 'win32',
    workspace: folder(WSL_PATH),
    request: { ...powershell, shellOverride: 'wsl.exe' },
    provider: WSL_EXE
  }),
  // A folder borrows the runtime of a repo it contains (or equals), not of a repo it sits inside.
  typed('Windows folder containing a WSL-project repo', {
    client: 'win32',
    workspace: folder(ALICE, { repoPath: WIN_PATH, projectRuntime: WSL_UBUNTU }),
    request: { ...powershell, shellOverride: 'wsl.exe', projectRuntime: WSL_PROJECT },
    provider: WSL_EXE
  }),
  typed('Windows folder inside a WSL-project repo', {
    client: 'win32',
    workspace: folder(`${WIN_PATH}\\pkg`, { repoPath: WIN_PATH, projectRuntime: WSL_UBUNTU }),
    request: { ...powershell, shellOverride: 'powershell.exe' },
    provider: PWSH
  }),
  typed('macOS client, SSH repo', {
    client: 'darwin',
    workspace: repo(POSIX_PATH, { connectionId: 'ssh-1' }),
    request: posix,
    provider: ZSH
  }),
  typed('Windows client, SSH repo', {
    client: 'win32',
    workspace: repo(POSIX_PATH, { connectionId: 'ssh-1' }),
    request: posix,
    provider: ZSH
  }),
  typed('macOS client, SSH Windows-path repo', {
    client: 'darwin',
    workspace: repo(WIN_PATH, { connectionId: 'ssh-1' }),
    request: powershell,
    provider: ZSH
  }),
  typed('macOS client, SSH folder', {
    client: 'darwin',
    workspace: folder(POSIX_PATH, { connectionId: 'ssh-1' }),
    request: posix,
    provider: ZSH
  }),
  resume('continue, macOS repo, transcript cwd', MAC_T, `${POSIX_PATH}/pkg`, {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    request: { ...agy(MAC_T), cwd: `${POSIX_PATH}/pkg` },
    provider: ZSH
  }),
  resume('continue, macOS repo, no transcript cwd', MAC_T, null, {
    client: 'darwin',
    workspace: repo(POSIX_PATH),
    request: agy(MAC_T),
    provider: ZSH
  }),
  resume('continue, Windows C: repo', WIN_T, WIN_PATH, {
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: { ...agy(WIN_T), shellOverride: 'powershell.exe', projectRuntime: HOST_GLOBAL },
    provider: PWSH
  }),
  // cmd escapes the prompt's inner quotes with a caret.
  resume('continue, Windows C: repo, cmd.exe', WIN_T, WIN_PATH, {
    ...CMD,
    client: 'win32',
    workspace: repo(WIN_PATH),
    request: {
      command: `agy "${SKIP}" --prompt-interactive "${reference(WIN_T).replace(/"/g, '^"')}"`,
      agentCommand: `agy "${SKIP}"`,
      shellOverride: 'cmd.exe',
      projectRuntime: HOST_GLOBAL
    },
    provider: CMD_EXE
  }),
  // The \\wsl$ transcript path is rewritten to its Linux spelling; the Linux cwd goes out as is.
  resume(
    'continue, Windows wsl$ WSL-project repo',
    `//wsl.localhost/Ubuntu/home/alice/${BRAIN}`,
    POSIX_PATH,
    {
      client: 'win32',
      workspace: repo(WSL_PATH, { projectRuntime: WSL_UBUNTU }),
      request: {
        ...agy(LINUX_T),
        cwd: POSIX_PATH,
        shellOverride: 'wsl.exe',
        projectRuntime: WSL_PROJECT
      },
      provider: WSL_EXE
    }
  ),
  resume('continue, Windows client, SSH repo, command override', LINUX_T, POSIX_PATH, {
    client: 'win32',
    workspace: repo(POSIX_PATH, { connectionId: 'ssh-1' }),
    settings: { agentCmdOverrides: { antigravity: '/opt/agy/bin/agy' } },
    request: agy(LINUX_T, '/opt/agy/bin/agy'),
    provider: ZSH
  })
]
