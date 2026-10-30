import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from './agent-session-host-authority'
import { isPtyIncarnationId } from './pty-incarnation'
import type {
  AgentSessionExecutionClaim,
  AgentSessionSurfaceBinding
} from './agent-session-host-authority'
import type { PtyIncarnationId } from './pty-incarnation'
export type PreparedAgentLaunchIdentity = {
  operationId: string
  fingerprint: string
  daemonGeneration: string
  reservationGeneration: string
}

export type PreparedAgentLaunchDescriptor = Pick<
  PreparedAgentLaunchIdentity,
  'daemonGeneration' | 'reservationGeneration'
> & {
  hostScope: { hostId: string; distro?: string; targetId?: string }
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  targetKind: 'existing' | 'new-git' | 'new-folder'
  launchTokenHash: string | null
  setup?: {
    operationId: string
    attemptId: string
    sessionId: string
    terminalHandle: string
    deadline: number
    incarnationId?: PtyIncarnationId
  }
  presentation: {
    tabId: string
    leafId: string
    groupId?: string
    primary: boolean
    title?: string
    color?: string
    templateId?: string
    renameBaseline?: string
    splitPlacement?: { afterTabId?: string }
  }
  extraTemplateIds?: string[]
  promptOwnerRef?: string
}

export type PreparedAgentLaunchStatus = PreparedAgentLaunchIdentity & {
  claim: AgentSessionExecutionClaim
  surface: AgentSessionSurfaceBinding
  accepted: boolean
  execution: 'not-dispatched' | 'dispatching' | 'started' | 'settled' | 'unknown'
  retirement: 'unused-retired' | 'retained-pending' | 'retained-live' | 'unknown'
  setup?: { sessionId: string; incarnationId?: PtyIncarnationId; exitCode?: number }
  physical?: { sessionId: string; incarnationId: PtyIncarnationId; startedAt: number }
  failure?:
    | 'setup-failed'
    | 'setup-ended'
    | 'setup-timeout'
    | 'spawn-failed'
    | 'cancelled'
    | 'expired'
  published: boolean
}

export function isPreparedAgentLaunchStatus(value: unknown): value is PreparedAgentLaunchStatus {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    'fingerprint' in value &&
    typeof value.fingerprint === 'string' &&
    'daemonGeneration' in value &&
    typeof value.daemonGeneration === 'string' &&
    'reservationGeneration' in value &&
    typeof value.reservationGeneration === 'string' &&
    'claim' in value &&
    isAgentSessionExecutionClaim(value.claim) &&
    'surface' in value &&
    isAgentSessionSurfaceBinding(value.surface) &&
    'accepted' in value &&
    typeof value.accepted === 'boolean' &&
    'published' in value &&
    typeof value.published === 'boolean' &&
    'execution' in value &&
    typeof value.execution === 'string' &&
    ['not-dispatched', 'dispatching', 'started', 'settled', 'unknown'].includes(value.execution) &&
    'retirement' in value &&
    typeof value.retirement === 'string' &&
    ['unused-retired', 'retained-pending', 'retained-live', 'unknown'].includes(value.retirement) &&
    (!('physical' in value) ||
      (typeof value.physical === 'object' &&
        value.physical !== null &&
        'sessionId' in value.physical &&
        typeof value.physical.sessionId === 'string' &&
        'incarnationId' in value.physical &&
        isPtyIncarnationId(value.physical.incarnationId) &&
        'startedAt' in value.physical &&
        typeof value.physical.startedAt === 'number')) &&
    (!('setup' in value) ||
      (typeof value.setup === 'object' &&
        value.setup !== null &&
        'sessionId' in value.setup &&
        typeof value.setup.sessionId === 'string' &&
        (!('incarnationId' in value.setup) || isPtyIncarnationId(value.setup.incarnationId))))
  )
}

export function isPreparedAgentLaunchDescriptor(
  value: unknown
): value is PreparedAgentLaunchDescriptor {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'daemonGeneration' in value &&
    typeof value.daemonGeneration === 'string' &&
    'reservationGeneration' in value &&
    typeof value.reservationGeneration === 'string' &&
    'claim' in value &&
    isAgentSessionExecutionClaim(value.claim) &&
    'surface' in value &&
    isAgentSessionSurfaceBinding(value.surface) &&
    'hostScope' in value &&
    typeof value.hostScope === 'object' &&
    value.hostScope !== null &&
    'hostId' in value.hostScope &&
    typeof value.hostScope.hostId === 'string' &&
    'targetKind' in value &&
    (value.targetKind === 'existing' ||
      value.targetKind === 'new-git' ||
      value.targetKind === 'new-folder') &&
    'launchTokenHash' in value &&
    (value.launchTokenHash === null || typeof value.launchTokenHash === 'string') &&
    'presentation' in value &&
    typeof value.presentation === 'object' &&
    value.presentation !== null &&
    'tabId' in value.presentation &&
    typeof value.presentation.tabId === 'string' &&
    'leafId' in value.presentation &&
    typeof value.presentation.leafId === 'string' &&
    'primary' in value.presentation &&
    typeof value.presentation.primary === 'boolean' &&
    (!('setup' in value) ||
      (typeof value.setup === 'object' &&
        value.setup !== null &&
        'operationId' in value.setup &&
        typeof value.setup.operationId === 'string' &&
        'attemptId' in value.setup &&
        typeof value.setup.attemptId === 'string' &&
        'sessionId' in value.setup &&
        typeof value.setup.sessionId === 'string' &&
        'terminalHandle' in value.setup &&
        typeof value.setup.terminalHandle === 'string' &&
        'deadline' in value.setup &&
        typeof value.setup.deadline === 'number'))
  )
}

export type PendingPreparedAgentLaunch = PreparedAgentLaunchIdentity & {
  worktreeId: string
  setupTerminalHandle?: string
}

export function matchesPreparedLaunchGeneration(
  value: unknown,
  identity: Pick<PreparedAgentLaunchIdentity, 'daemonGeneration' | 'reservationGeneration'>
): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'daemonGeneration' in value &&
    value.daemonGeneration === identity.daemonGeneration &&
    'reservationGeneration' in value &&
    value.reservationGeneration === identity.reservationGeneration
  )
}
