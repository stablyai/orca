import type { AgentStatus } from '../agent-title-core'
import type { ProgramStatusRecord } from './records'

/** Program-reported activity outranks title glyphs while its root record exists; null once reporting ends. */
export function programStatusActivity(root: ProgramStatusRecord | undefined): AgentStatus | null {
  switch (root?.state) {
    case undefined:
      return null
    case 'working':
      return 'working'
    case 'blocked':
      return 'permission'
    case 'idle':
    case 'done':
    case 'error':
      return 'idle'
  }
}
