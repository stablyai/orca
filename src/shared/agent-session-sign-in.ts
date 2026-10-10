import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'

export const AGENT_SESSION_SIGN_IN = [
  { agent: 'claude', loginCommand: ['claude', 'auth', 'login'] },
  { agent: 'codex', loginCommand: ['codex', 'login'] },
  { agent: 'grok', loginCommand: ['grok', 'login'] },
  { agent: 'opencode', loginCommand: ['opencode', 'auth', 'login'] },
  { agent: 'pi', loginCommand: ['pi'], slashCommand: '/login' },
  { agent: 'omp', loginCommand: [] }
] as const

export function agentSessionSignInFor(agent: string | undefined) {
  return AGENT_SESSION_SIGN_IN.find(
    (entry) => entry.agent === agent || TUI_AGENT_DISPLAY_NAMES[entry.agent] === agent
  )
}
