import { TUI_AGENT_DISPLAY_NAMES } from '../../agent-launch/catalog/tui-agent-display-names'
import type { AgentSessionAccountKind } from '../agent-session-availability'

export const AGENT_SESSION_SIGN_IN = [
  { agent: 'claude', loginCommand: ['claude', 'auth', 'login'] },
  // Why device auth from another device: these browser logins redirect to the host's localhost.
  {
    agent: 'codex',
    loginCommand: ['codex', 'login'],
    remoteLoginCommand: ['codex', 'login', '--device-auth']
  },
  {
    agent: 'grok',
    loginCommand: ['grok', 'login'],
    remoteLoginCommand: ['grok', 'login', '--device-auth']
  },
  { agent: 'opencode', loginCommand: ['opencode', 'auth', 'login'] },
  { agent: 'opencode2', loginCommand: ['opencode2', 'auth', 'login'] },
  { agent: 'pi', loginCommand: ['pi'], slashCommand: '/login' },
  { agent: 'omp', loginCommand: [] },
  { agent: 'gemini', loginCommand: ['gemini'], slashCommand: '/auth' },
  // An `agy` login does not sign its chats in: they keep their own sign-in.
  { agent: 'antigravity', loginCommand: [] }
] as const

export function agentSessionSignInFor(agent: string | undefined) {
  return AGENT_SESSION_SIGN_IN.find(
    (entry) => entry.agent === agent || TUI_AGENT_DISPLAY_NAMES[entry.agent] === agent
  )
}

/** The terminal command that signs `agent` in while the user watches from another device; null without one. */
export function agentSessionRemoteSignInCommand(
  agent: string | undefined,
  account?: AgentSessionAccountKind
): string | null {
  const entry = agentSessionSignInFor(agent)
  // Why: host terminals follow the selected managed Claude account; other managed logins aren't known to land.
  if (!entry || (account === 'managed' && entry.agent !== 'claude')) {
    return null
  }
  const argv = 'remoteLoginCommand' in entry ? entry.remoteLoginCommand : entry.loginCommand
  // Why a plain join: every word is a bare token, which POSIX, PowerShell and cmd all read alike.
  return argv.length > 0 ? argv.join(' ') : null
}
