import { isAskUserQuestionTool } from './agent-question-answered-intent'

type JsonRecord = Record<string, unknown>

export type CodexSubagentTranscriptLifecycleState = 'working' | 'waiting' | 'idle'

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

export function reconcileCodexSubagentTranscriptLifecycle(
  records: readonly JsonRecord[],
  initialState: CodexSubagentTranscriptLifecycleState
): { complete: boolean; state: CodexSubagentTranscriptLifecycleState } {
  let complete = false
  let state = initialState
  for (const recordValue of records) {
    const payload = record(recordValue.payload)
    if (!payload) {
      continue
    }
    if (recordValue.type === 'event_msg' && payload.type === 'task_started') {
      complete = false
      state = 'working'
    } else if (recordValue.type === 'event_msg' && payload.type === 'task_complete') {
      complete = true
    } else if (recordValue.type === 'response_item' && payload.type === 'function_call') {
      const toolName = typeof payload.name === 'string' ? payload.name : undefined
      state =
        toolName === 'wait_agent' ? 'idle' : isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
    } else if (
      recordValue.type === 'response_item' &&
      (payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'agent_message' ||
        payload.type === 'message')
    ) {
      state = 'working'
    }
  }
  return { complete, state }
}
