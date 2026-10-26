import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'

/** Keep per-agent resume argv separate from session metadata; type-only imports avoid runtime cycles. */
export function getAgentResumeArgv(
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata,
  ompResumeFilePath?: string | null
): string[] | null {
  const id = providerSession.id
  switch (agent) {
    case 'codebuddy':
      return providerSession.key === 'session_id' ? ['codebuddy', '--resume', id] : null
    case 'claude':
      return providerSession.key === 'session_id' ? ['claude', '--resume', id] : null
    case 'cursor':
      return providerSession.key === 'conversation_id' ? ['cursor-agent', '--resume', id] : null
    case 'codex':
      return providerSession.key === 'session_id' ? ['codex', 'resume', id] : null
    case 'qoder-cn':
      return providerSession.key === 'session_id' ? ['qoderclicn', '--resume', id] : null
    case 'qwen-code':
      return providerSession.key === 'session_id' ? ['qwen', '--resume', id] : null
    case 'qoder':
      return providerSession.key === 'session_id' ? ['qodercli', '--resume', id] : null
    case 'gemini':
      return providerSession.key === 'session_id' ? ['gemini', '--resume', id] : null
    case 'antigravity':
      return providerSession.key === 'conversation_id' ? ['agy', '--conversation', id] : null
    case 'opencode':
      return providerSession.key === 'session_id' ? ['opencode', '--session', id] : null
    case 'opencode2':
      // Why: the launch command owns standalone/shared mode, including user overrides.
      return providerSession.key === 'session_id' ? ['opencode2', '--session', id] : null
    case 'pi':
      return providerSession.key === 'session_id' && providerSession.transcriptPath
        ? ['pi', '--session', providerSession.transcriptPath]
        : null
    case 'prime-agent':
      return providerSession.key === 'session_id' && providerSession.transcriptPath
        ? ['prime-agent', '--resume', providerSession.transcriptPath]
        : null
    case 'mimo-code':
      return providerSession.key === 'session_id' ? ['mimo', '--session', id] : null
    case 'droid':
      return providerSession.key === 'session_id' ? ['droid', '--resume', id] : null
    case 'grok':
      return providerSession.key === 'session_id' ? ['grok', '--resume', id] : null
    case 'devin':
      return providerSession.key === 'session_id' ? ['devin', '--resume', id] : null
    case 'omp':
      return providerSession.key === 'session_id'
        ? [
            'omp',
            '--resume',
            ompResumeFilePath?.trim() || providerSession.transcriptPath?.trim() || id
          ]
        : null
    // Use Copilot's documented joined spelling, matching persisted AI Vault commands across local/remote resumes.
    case 'copilot':
      return providerSession.key === 'session_id' ? ['copilot', `--resume=${id}`] : null
    // Why: Kimi resumes by id with --session; sessions are work-dir-scoped (enforced by callers).
    case 'kimi':
      return providerSession.key === 'session_id' ? ['kimi', '--session', id] : null
    case 'muse':
      return providerSession.key === 'session_id' ? ['muse', 'resume', id] : null
    case 'zcode':
      return providerSession.key === 'session_id' ? ['zcode', '--resume', id] : null
    // DSH resumes by workspace path; callers must preserve cwd.
    case 'dsh':
      return providerSession.key === 'session_id' ? ['dsh-tui', '--resume', id] : null
    case 'jcode':
      return providerSession.key === 'session_id' ? ['jcode', '--resume', id] : null
    case 'kiro':
      return providerSession.key === 'session_id' ? ['kiro-cli', '--resume-id', id] : null
    case 'hermes':
      return providerSession.key === 'session_id' ? ['hermes', '--resume', id] : null
  }
}

/** CLI fork creates a new conversation ID so chat and terminal cannot write the same one. */
const FORK_ARGV: Partial<
  Record<ResumableTuiAgent, (providerSession: AgentProviderSessionMetadata) => string[] | null>
> = {
  claude: ({ id }) => ['claude', '--resume', id, '--fork-session'],
  codex: ({ id }) => ['codex', 'fork', id],
  grok: ({ id }) => ['grok', '--resume', id, '--fork-session'],
  pi: ({ transcriptPath }) => (transcriptPath ? ['pi', '--fork', transcriptPath] : null)
}

/** OpenCode2.0.14/OMP17.0.5 fork through ACP session/fork then resume the copy. Refuse without host-advertised fork; OpenCode2 chats list as opencode2. */
const FORKS_THROUGH_CHAT: ReadonlySet<string> = new Set<ResumableTuiAgent>([
  'opencode',
  'opencode2',
  'omp'
])

/** Whether "Resume in New CLI" can open a copy of this agent's conversations at all. A row's own
 *  gate (`aiVaultSessionCliForkWorktreeId`) also checks that its copy can be made. */
export function agentForksConversations(agent: string): boolean {
  return Object.hasOwn(FORK_ARGV, agent) || FORKS_THROUGH_CHAT.has(agent)
}

export function agentForksThroughChat(agent: string): boolean {
  return FORKS_THROUGH_CHAT.has(agent)
}

export function getAgentForkArgv(
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata
): string[] | null {
  const forkArgv = FORK_ARGV[agent]
  return forkArgv && providerSession.key === 'session_id' ? forkArgv(providerSession) : null
}
