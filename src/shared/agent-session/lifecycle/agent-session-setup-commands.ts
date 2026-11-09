import { TUI_AGENT_DISPLAY_NAMES } from '../../agent-launch/catalog/tui-agent-display-names'
import type { AgentSessionAccountKind } from '../agent-session-availability'

/** How a chat host installs and signs in each agent. `installCommand` is a POSIX shell line. */
export const AGENT_SESSION_SETUP_COMMANDS = [
  {
    agent: 'claude',
    loginCommand: ['claude', 'auth', 'login'],
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  // Why device auth from another device: these browser logins redirect to the host's localhost.
  {
    agent: 'codex',
    loginCommand: ['codex', 'login'],
    remoteLoginCommand: ['codex', 'login', '--device-auth'],
    installCommand: 'npm install -g @openai/codex'
  },
  {
    agent: 'grok',
    loginCommand: ['grok', 'login'],
    remoteLoginCommand: ['grok', 'login', '--device-auth']
  },
  {
    agent: 'opencode',
    loginCommand: ['opencode', 'auth', 'login'],
    installCommand: 'curl -fsSL https://opencode.ai/install | bash'
  },
  { agent: 'opencode2', loginCommand: ['opencode2', 'auth', 'login'] },
  { agent: 'pi', loginCommand: ['pi'], slashCommand: '/login' },
  { agent: 'omp', loginCommand: ['omp'], slashCommand: '/login' },
  // An `agy` login does not sign its chats in: they keep their own sign-in.
  { agent: 'antigravity', loginCommand: [] }
] as const

export function agentSessionSetupFor(agent: string | undefined) {
  return AGENT_SESSION_SETUP_COMMANDS.find(
    (entry) => entry.agent === agent || TUI_AGENT_DISPLAY_NAMES[entry.agent] === agent
  )
}

/** The terminal command that signs `agent` in on its chat host; `remote` when the user watches from another device. */
export function agentSessionSignInCommand(
  agent: string | undefined,
  options: { account?: AgentSessionAccountKind; remote: boolean }
): string | null {
  const entry = agentSessionSetupFor(agent)
  // Why: host terminals follow the selected managed Claude account; other managed logins aren't known to land.
  if (!entry || (options.account === 'managed' && entry.agent !== 'claude')) {
    return null
  }
  const argv =
    options.remote && 'remoteLoginCommand' in entry ? entry.remoteLoginCommand : entry.loginCommand
  // Why a plain join: every word is a bare token, which POSIX, PowerShell and cmd all read alike.
  return argv.length > 0 ? argv.join(' ') : null
}

/** The shell line that installs `agent` on a host of `hostPlatform`; null when unknown, Windows, or without one. */
export function agentSessionInstallCommand(
  agent: string | undefined,
  hostPlatform: string | null | undefined
): string | null {
  const entry = agentSessionSetupFor(agent)
  return hostPlatform && hostPlatform !== 'win32' && entry && 'installCommand' in entry
    ? entry.installCommand
    : null
}
