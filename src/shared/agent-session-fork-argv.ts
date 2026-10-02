import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'

export const NATIVE_FORK_TUI_AGENTS = [
  'claude',
  'codex'
] as const satisfies readonly ResumableTuiAgent[]

export type NativeForkTuiAgent = (typeof NATIVE_FORK_TUI_AGENTS)[number]

const NATIVE_FORK_TUI_AGENT_SET: ReadonlySet<string> = new Set(NATIVE_FORK_TUI_AGENTS)

export function supportsNativeAgentFork(agent: string): agent is NativeForkTuiAgent {
  return NATIVE_FORK_TUI_AGENT_SET.has(agent)
}

// Why: a fork gets a new provider session id, so the source session keeps its own writer.
export function getAgentForkArgv(
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata
): string[] | null {
  const id = providerSession.id.trim()
  if (providerSession.key !== 'session_id' || !id) {
    return null
  }
  switch (agent) {
    case 'claude':
      return ['claude', '--resume', id, '--fork-session']
    case 'codex':
      // Why: the fork runs in the child worktree, so skip Codex's session-vs-current cwd prompt.
      return ['codex', 'fork', '-c', 'tui.resume_cwd=current', id]
    // Why: exhaustive (no default) so a new ResumableTuiAgent forces an explicit fork decision.
    case 'gemini':
    case 'antigravity':
    case 'opencode':
    case 'opencode2':
    case 'pi':
    case 'mimo-code':
    case 'droid':
    case 'grok':
    case 'devin':
    case 'omp':
    case 'prime-agent':
    case 'copilot':
    case 'kimi':
    case 'muse':
    case 'zcode':
      return null
  }
}
