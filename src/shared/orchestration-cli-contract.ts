import { GLOBAL_FLAGS } from './cli-args-parser'

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
