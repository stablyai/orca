// Test-only (never imported by production code): the window-lane launch parity table for rows 2
// (typed prompt into a new tab) and 6 (continue from transcript). Renderer suites assert a real
// producer + pane sends `request`; main suites feed it to pty:spawn and assert `provider`.
import type {
  LaunchClient,
  LaunchWorkspace,
  WindowLaunchCase,
  WindowLaunchProducer,
  WindowProviderFacts,
  WindowRequestFacts
} from './launch-parity-window-request.test-fixture'

export const POSIX_PATH = '/home/alice/repo'
export const WIN_PATH = String.raw`C:\Users\alice\repo`
export const WSL_PATH = String.raw`\\wsl$\Ubuntu\home\alice\repo`

const SKIP = '--dangerously-skip-permissions'
const POSIX_CLAUDE = `claude '${SKIP}'`
const CMD_CLAUDE = `claude "${SKIP}"`
// The auto-submitted prompt rides on argv.
const posix = { command: `${POSIX_CLAUDE} 'fix Bob'"'"'s bug'`, agentCommand: POSIX_CLAUDE }
const ps = { command: `${POSIX_CLAUDE} 'fix Bob''s bug'`, agentCommand: POSIX_CLAUDE }
const cmd = { command: `${CMD_CLAUDE} "fix Bob's bug"`, agentCommand: CMD_CLAUDE }

const BRAIN = '.gemini/antigravity-ide/brain/ide-id/transcript_full.jsonl'
const MAC_T = `/Users/alice/${BRAIN}`
const WIN_T = `C:/Users/alice/${BRAIN}`
const LINUX_T = `/home/alice/${BRAIN}`
const reference = (path: string): string =>
  `Review the chat transcript at "${path}". Confirm your understanding of the previous conversation and continue from where it left off. This starts a new CLI conversation using the original transcript as a reference.`
const agy = (path: string, bin = 'agy'): WindowRequestFacts => ({
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
const ssh = { connectionId: 'ssh-1' }
const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
const HOST_SENT = { projectRuntime: { kind: 'windows-host', reason: 'global-default' } } as const
const WSL_SENT = {
  projectRuntime: { kind: 'wsl', reason: 'project-override', distro: 'Ubuntu' }
} as const
const IN_PWSH = { shellOverride: 'powershell.exe' }
const IN_WSL = { shellOverride: 'wsl.exe' }
// Main runs a local pane in the settings shell; Windows adds the WSL distro it derived.
const ZSH = { shellOverride: '/bin/zsh' }
// A Windows client's default shell setting is '' (its Settings UI hides it), so SSH gets no shell.
const NO_SHELL = { shellOverride: undefined }
const PWSH = { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
const WSL_EXE = { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' }
const CMD_EXE = { shellOverride: 'cmd.exe', terminalWindowsWslDistro: null }
const CMD = { terminalWindowsShell: 'cmd.exe' }

function launch(
  row: 2 | 6,
  producer: WindowLaunchProducer,
  name: string,
  client: LaunchClient,
  workspace: LaunchWorkspace,
  request: WindowRequestFacts,
  provider: WindowProviderFacts,
  settings?: Record<string, unknown>
): WindowLaunchCase {
  return { name, row, client, workspace, producer, request, provider, settings }
}
// A quick command's prompt; the apostrophe shows which shell the command was quoted for.
const quick = { kind: 'quick-command', agent: 'claude', prompt: "fix Bob's bug" } as const
const typed = launch.bind(null, 2, quick)
const resume = (transcript: string, cwd: string | null) =>
  launch.bind(null, 6, { kind: 'transcript-continue', transcript, cwd })

export const WINDOW_LAUNCH_CASES: WindowLaunchCase[] = [
  typed('macOS repo', 'darwin', repo(POSIX_PATH), posix, ZSH),
  typed('macOS folder', 'darwin', folder(POSIX_PATH), posix, ZSH),
  typed('Linux repo', 'linux', repo(POSIX_PATH), posix, ZSH),
  typed(
    'macOS repo, saved default env',
    'darwin',
    repo(POSIX_PATH),
    { ...posix, agentEnv: { A: '1' } },
    ZSH,
    {
      agentDefaultEnv: { claude: { A: '1' } }
    }
  ),
  // The draft rides --prefill.
  launch(
    2,
    {
      kind: 'continuation',
      agent: 'claude',
      prompt: "fix Bob's bug",
      initialCwd: `${POSIX_PATH}/pkg`
    },
    'macOS repo, terminal continuation in the pane cwd',
    'darwin',
    repo(POSIX_PATH),
    {
      command: `${POSIX_CLAUDE} --prefill 'fix Bob'"'"'s bug'`,
      agentCommand: POSIX_CLAUDE,
      cwd: `${POSIX_PATH}/pkg`
    },
    ZSH
  ),
  launch(
    2,
    { ...quick, agent: 'codex' },
    'macOS repo, codex auto-submit waits for the shell',
    'darwin',
    repo(POSIX_PATH),
    {
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob'"'"'s bug'`,
      agentCommand: `codex '--dangerously-bypass-approvals-and-sandbox'`
    },
    ZSH
  ),
  typed(
    'Windows C: repo, default PowerShell',
    'win32',
    repo(WIN_PATH),
    { ...ps, ...IN_PWSH, ...HOST_SENT },
    PWSH
  ),
  typed(
    'Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    { ...cmd, shellOverride: 'cmd.exe', ...HOST_SENT },
    CMD_EXE,
    CMD
  ),
  // A never-saved \\wsl$ project reads as a WSL project override from its path.
  typed(
    'Windows wsl$ repo, no saved runtime',
    'win32',
    repo(WSL_PATH),
    { ...posix, ...IN_WSL, ...WSL_SENT },
    WSL_EXE
  ),
  typed(
    'Windows C: repo, project WSL',
    'win32',
    repo(WIN_PATH, { projectRuntime: WSL_UBUNTU }),
    { ...posix, ...IN_WSL, ...WSL_SENT },
    WSL_EXE
  ),
  // main today: quoted for PowerShell, yet the \\wsl$ cwd names distro Ubuntu and the daemon runs wsl.exe.
  typed(
    'Windows wsl$ repo, project Windows host',
    'win32',
    repo(WSL_PATH, { projectRuntime: { kind: 'windows-host' } }),
    {
      ...ps,
      ...IN_PWSH,
      projectRuntime: { kind: 'windows-host', reason: 'project-override' } as const
    },
    { ...PWSH, terminalWindowsWslDistro: 'Ubuntu' }
  ),
  typed(
    'Windows C: repo, global default WSL',
    'win32',
    repo(WIN_PATH),
    {
      ...posix,
      ...IN_WSL,
      projectRuntime: { kind: 'wsl', reason: 'global-default', distro: 'Ubuntu' } as const
    },
    WSL_EXE,
    { localWindowsRuntimeDefault: WSL_UBUNTU }
  ),
  typed('Windows C: folder', 'win32', folder(WIN_PATH), { ...ps, ...IN_PWSH }, PWSH),
  // The folder's \\wsl$ path makes its host Linux, matching the wsl.exe createTab picks from the path.
  typed('Windows wsl$ folder', 'win32', folder(WSL_PATH), { ...posix, ...IN_WSL }, WSL_EXE),
  // A folder borrows the runtime of a repo it contains (or equals), not of a repo it sits inside.
  typed(
    'Windows folder containing a WSL-project repo',
    'win32',
    folder(String.raw`C:\Users\alice`, {
      repoPath: WIN_PATH,
      projectRuntime: WSL_UBUNTU
    }),
    { ...posix, ...IN_WSL, ...WSL_SENT },
    WSL_EXE
  ),
  typed(
    'Windows folder inside a WSL-project repo',
    'win32',
    folder(`${WIN_PATH}\\pkg`, {
      repoPath: WIN_PATH,
      projectRuntime: WSL_UBUNTU
    }),
    { ...ps, ...IN_PWSH },
    PWSH
  ),
  typed('macOS client, SSH repo', 'darwin', repo(POSIX_PATH, ssh), posix, ZSH),
  typed('Windows client, SSH repo', 'win32', repo(POSIX_PATH, ssh), posix, NO_SHELL),
  typed('macOS client, SSH Windows-path repo', 'darwin', repo(WIN_PATH, ssh), ps, ZSH),
  typed('macOS client, SSH folder', 'darwin', folder(POSIX_PATH, ssh), posix, ZSH),
  typed('Windows client, SSH folder', 'win32', folder(POSIX_PATH, ssh), posix, NO_SHELL),
  resume(MAC_T, `${POSIX_PATH}/pkg`)(
    'continue, macOS repo, transcript cwd',
    'darwin',
    repo(POSIX_PATH),
    {
      ...agy(MAC_T),
      cwd: `${POSIX_PATH}/pkg`
    },
    ZSH
  ),
  resume(MAC_T, null)(
    'continue, macOS repo, no transcript cwd',
    'darwin',
    repo(POSIX_PATH),
    agy(MAC_T),
    ZSH
  ),
  // cmd escapes the prompt's inner quotes with a caret.
  resume(WIN_T, WIN_PATH)(
    'continue, Windows C: repo, cmd.exe',
    'win32',
    repo(WIN_PATH),
    {
      command: `agy "${SKIP}" --prompt-interactive "${reference(WIN_T).replace(/"/g, '^"')}"`,
      agentCommand: `agy "${SKIP}"`,
      shellOverride: 'cmd.exe',
      ...HOST_SENT
    },
    CMD_EXE,
    CMD
  ),
  // The \\wsl$ transcript path is rewritten to its Linux spelling; the Linux cwd goes out as is.
  resume(`//wsl.localhost/Ubuntu/home/alice/${BRAIN}`, POSIX_PATH)(
    'continue, Windows wsl$ WSL-project repo',
    'win32',
    repo(WSL_PATH, {
      projectRuntime: WSL_UBUNTU
    }),
    { ...agy(LINUX_T), cwd: POSIX_PATH, ...IN_WSL, ...WSL_SENT },
    WSL_EXE
  ),
  resume(LINUX_T, POSIX_PATH)(
    'continue, Windows client, SSH repo, command override',
    'win32',
    repo(POSIX_PATH, ssh),
    agy(LINUX_T, '/opt/agy/bin/agy'),
    NO_SHELL,
    {
      agentCmdOverrides: { antigravity: '/opt/agy/bin/agy' }
    }
  )
]
