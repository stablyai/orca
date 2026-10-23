import type { AgentStatus } from '../agent-title-core'
import type { ProgramStatusRecord } from './records'

/**
 * The program's own account of its activity in the vocabulary Orca's title tracker speaks, or null
 * once it stops reporting (its root record is gone). While non-null it outranks title glyphs.
 */
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
