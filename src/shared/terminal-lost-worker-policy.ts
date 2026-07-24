import { normalizeAgentProviderSession } from './agent-session-resume'
import { isTuiAgent } from './tui-agent-config'
import type { TerminalArchiveHint } from './terminal-archive-types'

export type LostTerminalClassification =
  | {
      kind: 'worker'
      evidence: ('provider-session' | 'orchestration-task' | 'launch-agent')[]
    }
  | { kind: 'ordinary-shell' }

function hasBoundedTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value
  )
}

/** Classifies only durable facts; startup commands are never worker evidence. */
export function classifyLostTerminal(
  hint:
    | Pick<TerminalArchiveHint, 'providerSession' | 'orchestrationTaskId' | 'launchAgent'>
    | null
    | undefined
): LostTerminalClassification {
  const evidence: ('provider-session' | 'orchestration-task' | 'launch-agent')[] = []
  if (normalizeAgentProviderSession(hint?.providerSession)) {
    evidence.push('provider-session')
  }
  if (hasBoundedTaskId(hint?.orchestrationTaskId)) {
    evidence.push('orchestration-task')
  }
  if (isTuiAgent(hint?.launchAgent)) {
    evidence.push('launch-agent')
  }
  return evidence.length > 0 ? { kind: 'worker', evidence } : { kind: 'ordinary-shell' }
}
