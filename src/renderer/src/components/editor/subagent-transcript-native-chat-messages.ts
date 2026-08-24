import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatRole
} from '../../../../shared/native-chat-types'
import {
  parseSubagentJsonlTranscript,
  type SubagentTranscriptStep
} from './subagent-transcript-parser'

export function convertSubagentStepsToNativeChatMessages(
  steps: SubagentTranscriptStep[]
): NativeChatMessage[] {
  return steps.map((step) => {
    let role: NativeChatRole = 'system'
    const blocks: NativeChatBlock[] = []

    switch (step.type) {
      case 'USER_INPUT':
        role = 'user'
        blocks.push({ type: 'text', text: step.content || '' })
        break
      case 'THINKING':
        role = 'reasoning'
        blocks.push({ type: 'text', text: step.content || '' })
        break
      case 'MODEL_RESPONSE':
        role = 'assistant'
        blocks.push({ type: 'text', text: step.content || '' })
        break
      case 'TOOL_CALL': {
        role = 'assistant'
        blocks.push({
          type: 'tool-call',
          name: step.toolName || 'tool',
          input: step.toolArgs || {}
        })
        if (step.toolResult !== undefined && step.toolResult !== '') {
          blocks.push({
            type: 'tool-result',
            output: step.toolResult,
            isError: step.status === 'error'
          })
        }
        break
      }
      case 'ERROR':
        role = 'system'
        blocks.push({ type: 'text', text: `Error: ${step.content || ''}` })
        break
      default:
        role = 'system'
        blocks.push({ type: 'text', text: step.content || '' })
        break
    }

    let timestamp: number | null = null
    if (step.timestamp) {
      const parsedTime = Date.parse(step.timestamp)
      if (!Number.isNaN(parsedTime)) {
        timestamp = parsedTime
      }
    }

    return {
      id: step.id,
      role,
      blocks,
      timestamp,
      source: 'transcript'
    }
  })
}

export function parseSubagentTranscriptToNativeChatMessages(
  rawContent: string
): NativeChatMessage[] {
  const steps = parseSubagentJsonlTranscript(rawContent)
  return convertSubagentStepsToNativeChatMessages(steps)
}
