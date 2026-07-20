import { GLOBAL_FLAGS } from './cli-args-parser'

const ORCHESTRATION_LIFECYCLE_MESSAGE_TYPES = ['worker_done', 'heartbeat'] as const

export type OrchestrationLifecycleMessageType =
  (typeof ORCHESTRATION_LIFECYCLE_MESSAGE_TYPES)[number]

export function isLifecycleMessageType(
  type: string | undefined
): type is OrchestrationLifecycleMessageType {
  return ORCHESTRATION_LIFECYCLE_MESSAGE_TYPES.some((lifecycleType) => lifecycleType === type)
}

export const ORCHESTRATION_SEND_COMMAND_PATH = ['orchestration', 'send']
export const ORCHESTRATION_SEND_ALLOWED_FLAGS = [
  ...GLOBAL_FLAGS,
  'to',
  'from',
  'subject',
  'body',
  'type',
  'priority',
  'thread-id',
  'payload',
  'task-id',
  'dispatch-id',
  'files-modified',
  'report-path',
  'phase'
]
