// Test-only (never imported by production code): the window-lane launch parity table for row 1, the
// "+" launches C2 moves onto the pane trigger. One row per "+" entry point; local hosts only.
import { POSIX_PATH, WIN_PATH } from './launch-parity-window-cases.test-fixture'
import type {
  LaunchClient,
  LaunchWorkspace,
  PlusEntry,
  WindowLaunchCase,
  WindowProviderFacts,
  WindowRequestFacts
} from './launch-parity-window-request.test-fixture'

// A saved default arg with an apostrophe shows which shell the command was quoted for.
const ARGS = `--append-system-prompt "Bob's rules"`
const posix = `claude '--append-system-prompt' 'Bob'"'"'s rules'`
const ps = `claude '--append-system-prompt' 'Bob''s rules'`
const quoted = (command: string): WindowRequestFacts => ({
  command,
  agentCommand: command,
  agentArgs: ARGS
})
const ZSH = { shellOverride: '/bin/zsh' }

function plus(
  via: PlusEntry,
  name: string,
  client: LaunchClient,
  workspace: LaunchWorkspace,
  request: WindowRequestFacts,
  provider: WindowProviderFacts
): WindowLaunchCase {
  return {
    name: `${via} "+", ${name}`,
    row: 1,
    client,
    workspace,
    producer: { kind: 'plus', agent: 'claude', via },
    request,
    provider,
    settings: { agentDefaultArgs: { claude: ARGS } }
  }
}

export const PLUS_LAUNCH_CASES: WindowLaunchCase[] = [
  plus('menu', 'macOS repo', 'darwin', { kind: 'repo', path: POSIX_PATH }, quoted(posix), ZSH),
  plus(
    'shortcut',
    'Windows C: repo, default PowerShell',
    'win32',
    { kind: 'repo', path: WIN_PATH },
    {
      ...quoted(ps),
      shellOverride: 'powershell.exe',
      projectRuntime: { kind: 'windows-host', reason: 'global-default' }
    },
    { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
  ),
  plus('dashboard', 'Linux repo', 'linux', { kind: 'repo', path: POSIX_PATH }, quoted(posix), ZSH)
]
