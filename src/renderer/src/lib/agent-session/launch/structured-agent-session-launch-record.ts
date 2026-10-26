import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type {
  StructuredAgentSessionFirstMessage,
  StructuredAgentSessionResumeSource
} from '../../../../../shared/structured-agent-session-create'
import { isAgentSessionOptions } from '../../../../../shared/agent-session-record'
import { SendBodyStructure } from '../../../../../shared/rpc-contract/structured-agent-session-message-params'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

export type StructuredAgentLaunchPersistedLifecycle = 'pending' | 'visibility-unknown' | 'failed'

export type StructuredLaunchSurfaceAddress = {
  worktreeId: string
  targetGroupId?: string
  precedingTabIds: readonly string[]
}

export function parseStructuredLaunchSurfaceAddress(
  value: unknown
): StructuredLaunchSurfaceAddress | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('worktreeId' in value) ||
    typeof value.worktreeId !== 'string' ||
    !value.worktreeId ||
    !('precedingTabIds' in value) ||
    !Array.isArray(value.precedingTabIds) ||
    !value.precedingTabIds.every((id: unknown) => typeof id === 'string') ||
    ('targetGroupId' in value && typeof value.targetGroupId !== 'string')
  ) {
    return undefined
  }
  return {
    worktreeId: value.worktreeId,
    precedingTabIds: value.precedingTabIds,
    ...('targetGroupId' in value && typeof value.targetGroupId === 'string'
      ? { targetGroupId: value.targetGroupId }
      : {})
  }
}

export type StructuredAgentLaunchPersistedRecord = {
  surfaceAddress?: StructuredLaunchSurfaceAddress
  sessionId: string
  // Older records lack host because chats could only launch locally then; restore them as local.
  executionHostId: ExecutionHostId
  agent: TuiAgent
  lifecycle: StructuredAgentLaunchPersistedLifecycle
  clientOperationId: string
  payloadFingerprint: string
  expectedRuntimeFence: number | null
  resumeFrom?: StructuredAgentSessionResumeSource
  firstMessage?: StructuredAgentSessionFirstMessage
  options?: Readonly<Record<string, string>>
  createMessageSupport?: boolean
  /** A paired server's reported seed, which this machine cannot re-derive after a reload. */
  seedOptions?: Readonly<Record<string, string>>
  /** When a failed launch failed; records written by older builds lack it. */
  failedAt?: number
}

export function structuredAgentLaunchRecordFor(
  intent: StructuredAgentSessionLaunchIntent,
  lifecycle: StructuredAgentLaunchPersistedLifecycle
): StructuredAgentLaunchPersistedRecord {
  const { envelope, resumeFrom, firstMessage, options } = intent.params
  // A local launch re-reads this machine's settings on reload; only a paired server's seed is kept.
  const pairedSeed = intent.target.kind === 'local' ? undefined : intent.seedOptions
  return {
    ...(intent.surfaceAddress ? { surfaceAddress: intent.surfaceAddress } : {}),
    sessionId: intent.sessionId,
    executionHostId: intent.executionHostId,
    agent: intent.agent,
    lifecycle,
    clientOperationId: envelope.clientOperationId,
    payloadFingerprint: envelope.payloadFingerprint,
    expectedRuntimeFence: envelope.expectedRuntimeFence,
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(firstMessage ? { firstMessage } : {}),
    ...(options ? { options } : {}),
    ...(intent.createMessageSupport === undefined
      ? {}
      : { createMessageSupport: intent.createMessageSupport }),
    ...(pairedSeed ? { seedOptions: pairedSeed } : {})
  }
}

export function validRecord(value: unknown): value is Omit<
  StructuredAgentLaunchPersistedRecord,
  'executionHostId'
> & {
  executionHostId?: string
} {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (
    !('sessionId' in value) ||
    !('agent' in value) ||
    !('lifecycle' in value) ||
    !('clientOperationId' in value) ||
    !('payloadFingerprint' in value) ||
    !('expectedRuntimeFence' in value)
  ) {
    return false
  }
  const {
    sessionId,
    agent,
    lifecycle,
    clientOperationId,
    payloadFingerprint,
    expectedRuntimeFence
  } = value
  const resumeFrom = 'resumeFrom' in value ? value.resumeFrom : undefined
  const executionHostId = 'executionHostId' in value ? value.executionHostId : undefined
  const failedAt = 'failedAt' in value ? value.failedAt : undefined
  const firstMessage = 'firstMessage' in value ? value.firstMessage : undefined
  const options = 'options' in value ? value.options : undefined
  const createMessageSupport =
    'createMessageSupport' in value ? value.createMessageSupport : undefined
  return (
    (executionHostId === undefined ||
      (typeof executionHostId === 'string' && parseExecutionHostId(executionHostId) !== null)) &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    isTuiAgent(agent) &&
    (lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed') &&
    typeof clientOperationId === 'string' &&
    typeof payloadFingerprint === 'string' &&
    (expectedRuntimeFence === null || typeof expectedRuntimeFence === 'number') &&
    (failedAt === undefined || Number.isFinite(failedAt)) &&
    (firstMessage === undefined || validFirstMessage(firstMessage)) &&
    (options === undefined || isAgentSessionOptions(options)) &&
    (createMessageSupport === undefined || typeof createMessageSupport === 'boolean') &&
    (resumeFrom === undefined ||
      (typeof resumeFrom === 'object' &&
        resumeFrom !== null &&
        'providerSessionId' in resumeFrom &&
        typeof resumeFrom.providerSessionId === 'string'))
  )
}

function validFirstMessage(value: unknown): value is StructuredAgentSessionFirstMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'clientMessageId' in value &&
    typeof value.clientMessageId === 'string' &&
    'body' in value &&
    SendBodyStructure.safeParse(value.body).success
  )
}
