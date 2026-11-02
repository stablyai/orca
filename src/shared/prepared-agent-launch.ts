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
import type { WorktreeStartupLaunch } from './worktree/launch-types'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import { tuiAgentDisplayName } from './tui-agent-display-names'
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
  /** The creating main process that holds this launch's post-start prompt; never its bytes. */
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

/** An automatic launch outcome no surviving terminal shows; the window shows one short notice per operation. */
export type PreparedAgentLaunchNotice = {
  operationId: string
  worktreeId: string
  agent: string
  kind: 'setup-closed' | 'prompt-uncertain'
}

/** Accepted presentation the daemon returns to the exact publication observer; never listed or saved. */
export type PreparedLaunchPublication = {
  launchConfig?: WorktreeStartupLaunch['launchConfig']
  viewMode?: 'terminal' | 'chat'
  launchToken?: string
}

/** Each process fact only when it was read; only facts known on both sides are ever compared. */
export type PreparedLaunchIncarnation = {
  pid: number
  /** Linux PID namespace; start identities compare only within one. */
  namespace?: string
  /** Kernel process start (Linux start ticks, or start time elsewhere); never a command line. */
  start?: string
  boot?: string
}

/** The daemon is authenticated, but a reply still narrows before it reaches a terminal record. */
export function parsePreparedLaunchPublication(
  value: unknown
): PreparedLaunchPublication | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const launchConfig: unknown = Reflect.get(value, 'launchConfig')
  const viewMode: unknown = Reflect.get(value, 'viewMode')
  const launchToken: unknown = Reflect.get(value, 'launchToken')
  return {
    ...(isSleepingAgentLaunchConfig(launchConfig) ? { launchConfig } : {}),
    ...(viewMode === 'chat' || viewMode === 'terminal' ? { viewMode } : {}),
    ...(typeof launchToken === 'string' ? { launchToken } : {})
  }
}

function isSleepingAgentLaunchConfig(value: unknown): value is SleepingAgentLaunchConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const agentEnv: unknown = Reflect.get(value, 'agentEnv')
  return (
    typeof Reflect.get(value, 'agentArgs') === 'string' &&
    typeof agentEnv === 'object' &&
    agentEnv !== null &&
    Object.values(agentEnv).every((entry) => typeof entry === 'string')
  )
}

/** Only the named generation answers this; it holds no current or future work for the operation. */
export function isPreparedLaunchOperationUnknown(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('agent_session_operation_unknown')
}

/** Final outcome text for an automatic launch that did not produce a usable agent. */
export function preparedLaunchStatusFailureText(status: PreparedAgentLaunchStatus): string {
  const setupNeverRan =
    status.failure === 'spawn-failed' && status.setup !== undefined && !status.setup.incarnationId
  return preparedLaunchFailureText(
    status.physical ? 'exited' : setupNeverRan ? 'setup-not-started' : status.failure,
    status.claim.agent
  )
}

export function preparedLaunchFailureText(
  failure: PreparedAgentLaunchStatus['failure'] | 'exited' | 'setup-not-started',
  agent: string
): string {
  const name = tuiAgentDisplayName(agent) ?? agent
  switch (failure) {
    case 'setup-not-started':
      return `Setup could not start, so ${name} was not started. Check the Setup command, then start ${name} from a new tab.`
    case 'setup-failed':
      return `Setup failed, so ${name} was not started. Fix Setup, then start ${name} from a new tab.`
    case 'setup-timeout':
      return `Setup did not finish within 2 hours, so ${name} was not started. Start ${name} from a new tab when Setup is done.`
    case 'setup-ended':
      return `Setup was closed before it finished, so ${name} was not started. Start ${name} from a new tab.`
    case 'exited':
      return `${name} exited right after it started. Start ${name} again from a new tab.`
    default:
      return `${name} could not be started. Start ${name} from a new tab.`
  }
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
  /** The tab reserved for the eventual agent, so per-tab launch state lands there and never on Setup. */
  tabId?: string
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
