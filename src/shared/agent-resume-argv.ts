import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'

/** The argv that re-enters an existing session, per agent. Split from
 *  `agent-session-resume.ts` so adding an agent does not push that module past its line
 *  budget; type-only import back, so there is no runtime cycle. */
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
      return providerSession.key === 'session_id'
        ? ['opencode2', '--standalone', '--session', id]
        : null
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
    // Why: the joined form is the only one Copilot documents, and it matches the
    // flag spelling buildAgentResumeInvocation bakes into persisted AI Vault
    // resume commands, so local and remote resumes agree on one spelling.
    case 'copilot':
      return providerSession.key === 'session_id' ? ['copilot', `--resume=${id}`] : null
    // Why: Kimi resumes by id with --session; sessions are work-dir-scoped (enforced by callers).
    case 'kimi':
      return providerSession.key === 'session_id' ? ['kimi', '--session', id] : null
    case 'muse':
      return providerSession.key === 'session_id' ? ['muse', 'resume', id] : null
    case 'zcode':
      return providerSession.key === 'session_id' ? ['zcode', '--resume', id] : null
    // Why: `dsh-tui --resume <id>` re-enters the session the launcher recorded for this
    // workspace. DSH keys sessions by workspace path, so callers must keep the cwd.
    case 'dsh':
      return providerSession.key === 'session_id' ? ['dsh-tui', '--resume', id] : null
    case 'jcode':
      return providerSession.key === 'session_id' ? ['jcode', '--resume', id] : null
  }
}

/** Opens a copy of the conversation under a new id, leaving the original untouched. Only the two
 *  agents native chat can own a conversation for, which is the only case that needs a fork. */
export function getAgentForkArgv(
  agent: ResumableTuiAgent,
  providerSession: AgentProviderSessionMetadata
): string[] | null {
  if (providerSession.key !== 'session_id') {
    return null
  }
  if (agent === 'claude') {
    return ['claude', '--resume', providerSession.id, '--fork-session']
  }
  return agent === 'codex' ? ['codex', 'fork', providerSession.id] : null
}
