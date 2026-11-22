import { CODEX_ASYNC_QUESTION_TOOL } from '../../native-chat/input/questions/codex-async-question-input'
import type { AgentStatusEntry } from '../contracts/agent-status-types'

export type WorksBehindQuestionRow = Pick<AgentStatusEntry, 'state' | 'subagents'> & {
  toolName?: string | null
}

/** `waiting` marks Codex's async question as needing the user, yet its turn keeps running; a child's wait does block. */
export function agentWorksBehindQuestion(row: WorksBehindQuestionRow): boolean {
  return (
    row.state === 'waiting' &&
    row.toolName === CODEX_ASYNC_QUESTION_TOOL &&
    !row.subagents?.some((child) => child.state === 'waiting')
  )
}

/** For holds that protect running work; attention keeps reading `state`. */
export function isAgentExecuting(row: WorksBehindQuestionRow): boolean {
  return row.state === 'working' || agentWorksBehindQuestion(row)
}
