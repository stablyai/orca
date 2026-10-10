import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { structuredAgentSessionStatusFeedKey } from '@/runtime/structured-agent-session-status-feed'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * Which machine a restart offer belongs to: this computer, or one paired server.
 *
 * Keyed like the structured status feed (`local` | `environment:<id>`), so an offer and the feed
 * that watches its chats name the same machine the same way.
 */
export type RestartMachineKey = string

export const LOCAL_RESTART_MACHINE: RestartMachineKey = 'local'

export function restartMachineKey(target: RuntimeClientTarget): RestartMachineKey {
  return structuredAgentSessionStatusFeedKey(target)
}

const ENVIRONMENT_PREFIX = 'environment:'

export function restartMachineTarget(machine: RestartMachineKey): RuntimeClientTarget {
  return machine.startsWith(ENVIRONMENT_PREFIX)
    ? { kind: 'environment', environmentId: machine.slice(ENVIRONMENT_PREFIX.length) }
    : { kind: 'local' }
}

/**
 * A paired server's rows in this desktop's terms.
 *
 * The server builds its host as `local`, so every row it lists names ITS machine as `local`. Here
 * that is the server's runtime host, which is the id this desktop files its workspaces under.
 */
export function projectRestartMachineRows<Row extends ResumeCandidate>(
  target: RuntimeClientTarget,
  rows: readonly Row[]
): Row[] {
  if (target.kind === 'local') {
    return [...rows]
  }
  const executionHostId = restartMachineExecutionHostId(target)
  return rows.map((row) => ({ ...row, executionHostId }))
}

/** The host this desktop files a machine's workspaces under. */
export function restartMachineExecutionHostId(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}
