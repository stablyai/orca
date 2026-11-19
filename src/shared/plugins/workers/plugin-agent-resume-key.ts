import { getAgentResumeArgv } from '../../agent-launch/startup/agent-resume-argv'
import type {
  AgentProviderSessionKey,
  ResumableTuiAgent
} from '../../agent-session/lifecycle/agent-session-resume'

const SESSION_KEYS: readonly AgentProviderSessionKey[] = ['session_id', 'conversation_id']

/** The key an agent resumes a session id by; null for agents that resume from a transcript file. */
export function pluginResumeKey(agent: ResumableTuiAgent): AgentProviderSessionKey | null {
  return SESSION_KEYS.find((key) => getAgentResumeArgv(agent, { key, id: 'id' }) !== null) ?? null
}
