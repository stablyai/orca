import { z } from 'zod'
import { isTuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  StructuredAgentSessionFirstMessage,
  StructuredAgentSessionResumeSource
} from '../../../../../shared/agent-session/structured-agent-session-create'
import { isAgentSessionOptions } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  MAX_BLOCKS,
  SendBodyStructure
} from '../../../../../shared/rpc-contract/structured-agent-session-message-params'
import { AgentLaunchRelease } from '../../../../../shared/rpc-contract/agent-launch-release-params'
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

const FirstTurnChoices = AgentLaunchRelease.omit({ operationId: true, firstMessage: true })

const HostLaunchFirstTurnSchema = z.discriminatedUnion('phase', [
  FirstTurnChoices.extend({
    phase: z.literal('editing'),
    /** The held message's client files still to upload to its host, by the path the staging
     *  owner holds them under: metadata only, never bytes or a second copy of the message. */
    staged: z.array(z.string().min(1).max(4096)).min(1).max(MAX_BLOCKS).optional()
  }).strict(),
  FirstTurnChoices.extend({ phase: z.literal('submitted') }).strict()
])

/** A host launch's first turn, released to it after Setup. `editing`: the choices the chat showed
 *  when it started, which the user may still change, and the files its message still needs on the
 *  host; `submitted`: the exact input release sent, its message host-readable, sent again unchanged
 *  and never edited. The message itself is the launch's own `firstMessage`. */
export type HostLaunchFirstTurn = z.infer<typeof HostLaunchFirstTurnSchema>

/** Unreadable is absent: nothing is guessed in its place, so that launch is never released. Files
 *  still to upload must belong to the saved message; otherwise the evidence is inconsistent. */
export function parseHostLaunchFirstTurn(
  value: unknown,
  firstMessage?: StructuredAgentSessionFirstMessage
): HostLaunchFirstTurn | undefined {
  const parsed = HostLaunchFirstTurnSchema.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const staged = parsed.data.phase === 'editing' ? parsed.data.staged : undefined
  return !staged || (firstMessage && staged.every((path) => messageNamesPath(firstMessage, path)))
    ? parsed.data
    : undefined
}

function messageNamesPath(message: StructuredAgentSessionFirstMessage, path: string): boolean {
  return message.body.blocks.some((block) =>
    block.type === 'text' ? block.text.includes(path) : block.path === path
  )
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
  /** The executing host's own launch, which a reload reads again; older builds ignore it. */
  hostLaunchOperationId?: string
  /** That launch takes its first turn's final choices after Setup; absent, it was accepted whole. */
  hostLaunchFirstTurn?: HostLaunchFirstTurn
  firstMessage?: StructuredAgentSessionFirstMessage
  explicitLaunchOptions?: Readonly<Record<string, string>>
  optionsMode?: 'replace-model-selection'
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
  const { envelope, resumeFrom, optionsMode, options } = intent.params
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
    ...(intent.hostLaunch ? { hostLaunchOperationId: intent.hostLaunch.operationId } : {}),
    ...(intent.hostLaunch?.firstTurn ? { hostLaunchFirstTurn: intent.hostLaunch.firstTurn } : {}),
    ...(intent.opening ? { firstMessage: intent.opening } : {}),
    ...(optionsMode ? { optionsMode } : {}),
    ...(options ? { options } : {}),
    ...(intent.explicitLaunchOptions
      ? { explicitLaunchOptions: intent.explicitLaunchOptions }
      : {}),
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
  const hostLaunchOperationId =
    'hostLaunchOperationId' in value ? value.hostLaunchOperationId : undefined
  const firstMessage = 'firstMessage' in value ? value.firstMessage : undefined
  const optionsMode = 'optionsMode' in value ? value.optionsMode : undefined
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
    (hostLaunchOperationId === undefined || typeof hostLaunchOperationId === 'string') &&
    (firstMessage === undefined || validFirstMessage(firstMessage)) &&
    (optionsMode === undefined || optionsMode === 'replace-model-selection') &&
    (options === undefined || isAgentSessionOptions(options)) &&
    (!('explicitLaunchOptions' in value) ||
      value.explicitLaunchOptions === undefined ||
      isAgentSessionOptions(value.explicitLaunchOptions)) &&
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
