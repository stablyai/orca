import { isRecord } from '../../../agent-status/child-work/agent-status-child-work-value-guards'

export type AntigravityTranscriptOrigin = 'root' | 'child' | 'unknown'

export function classifyAntigravityTranscriptOrigin(origin: unknown): AntigravityTranscriptOrigin {
  if (!isRecord(origin)) {
    return 'unknown'
  }
  if (origin.source === 'USER_EXPLICIT' && origin.type === 'USER_INPUT') {
    return 'root'
  }
  if (origin.source === 'SYSTEM' && origin.type === 'SYSTEM_MESSAGE') {
    return 'child'
  }
  return 'unknown'
}
