import { isOptionalUsageLimitContinueCancel } from '../stopping/agent-session-usage-limit-continue'
import type { AgentSessionDeathEvidence } from '../leases/agent-session-death-evidence'
import { isAgentSessionRewindRecord } from '../rewind/agent-session-rewind'
import { isAgentSessionLaunchArgs } from './agent-session-launch-args'
import { isAgentSessionConversationName } from '../../conversation-naming/agent-session-conversation-name'
import {
  isPersistedAgentSessionHandoffStage,
  isPersistedAgentSessionRuntimeKind,
  type PersistedAgentSessionObservationLease,
  type PersistedAgentSessionObservationRecord,
  type PersistedAgentSessionRecord
} from '../leases/agent-session-legacy-handoff-lease'
import type {
  AgentSessionProviderSelection,
  AgentSessionProviderSwitch,
  DeferredProviderContext
} from './agent-session-provider-selection'
import { isAgentSessionConversationCommandRecord } from '../../conversation-context/agent-session-conversation-command'
import { decodePersistedAgentSessionProviderHandleChain } from '../provider-handles/agent-session-provider-handle'
import { isAgentSessionProviderContextBoundary } from '../../conversation-context/agent-session-provider-context'
import { isStructuredAgentId } from '../provider-handles/agent-session-provider-handle-encoding'
import { isNonNegativeSafeInteger } from '../../../remote-runtime/ssh/ssh-retained-payload-limits'
import { isAgentChatPermissionChoice } from '../../../agent-launch/permissions/agent-chat-permission-mode'
import {
  isAgentSessionAccountHome,
  isOptionalAgentSessionLaunchedAccount,
  MAX_PATH_LENGTH
} from '../accounts/agent-session-account-home'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  MAX_AGENT_SESSION_DEATH_DETAIL_CHARS,
  isAgentSessionExecutionLocation,
  isAgentSessionId,
  isAgentSessionOptions,
  isAgentSessionProcessIdentity
} from '../agent-session-record'

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

function isAgentSessionDeathEvidence(value: unknown): value is AgentSessionDeathEvidence {
  if (!isStoredRecordObject(value)) {
    return false
  }
  const evidence = value
  const { observedAt, lastProvenAliveAt, ownerFence, runtimeEnd } = evidence
  return (
    (evidence.kind === 'exit-observed' ||
      evidence.kind === 'kill-delivered' ||
      evidence.kind === 'pid-absent' ||
      evidence.kind === 'identity-mismatch') &&
    isBoundedString(evidence.detail, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS) &&
    isNonNegativeSafeInteger(observedAt) &&
    (ownerFence === undefined || isNonNegativeSafeInteger(ownerFence)) &&
    (lastProvenAliveAt === undefined ||
      (isNonNegativeSafeInteger(lastProvenAliveAt) && lastProvenAliveAt <= observedAt)) &&
    (runtimeEnd === undefined || isBoundedString(runtimeEnd, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS))
  )
}

function isStoredRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPersistedAgentSessionObservationLease(
  lease: unknown
): lease is PersistedAgentSessionObservationLease {
  return (
    isStoredRecordObject(lease) &&
    isAgentSessionId(lease.sessionId) &&
    isPersistedAgentSessionRuntimeKind(lease.runtimeKind) &&
    typeof lease.runtimeFence === 'number' &&
    Number.isSafeInteger(lease.runtimeFence) &&
    lease.runtimeFence >= 0 &&
    (lease.handoffStage === null || isPersistedAgentSessionHandoffStage(lease.handoffStage)) &&
    (lease.provenHandleLinkId === null || isBoundedString(lease.provenHandleLinkId, 128)) &&
    (lease.ownerProcess === null || isAgentSessionProcessIdentity(lease.ownerProcess)) &&
    (lease.reservedSpawnToken === null ||
      isBoundedString(lease.reservedSpawnToken, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS)) &&
    Number.isSafeInteger(lease.leaseDeadlineAt) &&
    Number.isSafeInteger(lease.lastRenewedAt) &&
    (lease.handoffOperationId === null ||
      isBoundedString(lease.handoffOperationId, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS)) &&
    isBoundedString(lease.claimKeyId, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS) &&
    (lease.claimStatus === 'reserved' ||
      lease.claimStatus === 'live' ||
      lease.claimStatus === 'conflicted' ||
      lease.claimStatus === 'released') &&
    typeof lease.unreconciled === 'boolean' &&
    (lease.deathEvidence === null || isAgentSessionDeathEvidence(lease.deathEvidence))
  )
}

/** Stored identity is independent of registrations; availability is checked only at start. */
export function isPersistedAgentSessionObservationRecord(
  value: unknown
): value is PersistedAgentSessionObservationRecord {
  if (!isStoredRecordObject(value)) {
    return false
  }
  const record = value
  if (
    !(
      record.schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION &&
      isAgentSessionId(record.sessionId) &&
      isAgentSessionExecutionLocation(record.location) &&
      isStructuredAgentId(record.provider) &&
      isAgentSessionAccountHome(record.accountHome) &&
      isOptionalAgentSessionLaunchedAccount(record.launchedAccount) &&
      (record.launchDirectory === undefined ||
        isBoundedString(record.launchDirectory, MAX_PATH_LENGTH)) &&
      (record.options === undefined || isAgentSessionOptions(record.options)) &&
      (record.permissionMode === undefined ||
        isBoundedString(record.permissionMode, MAX_AGENT_SESSION_DEATH_DETAIL_CHARS)) &&
      isOptionalUsageLimitContinueCancel(record.usageLimitContinueCancel) &&
      (record.rewind === undefined || isAgentSessionRewindRecord(record.rewind)) &&
      (record.providerContextBoundary === undefined ||
        isAgentSessionProviderContextBoundary(record.providerContextBoundary)) &&
      (record.conversationCommand === undefined ||
        isAgentSessionConversationCommandRecord(record.conversationCommand)) &&
      (record.conversationName === undefined ||
        isAgentSessionConversationName(record.conversationName)) &&
      (record.conversationNameSource === undefined || record.conversationNameSource === 'user') &&
      (record.launchArgs === undefined || isAgentSessionLaunchArgs(record.launchArgs)) &&
      !Object.hasOwn(record, 'launchEnv') &&
      isPersistedAgentSessionObservationLease(record.lease) &&
      record.lease.sessionId === record.sessionId &&
      Number.isSafeInteger(record.createdAt) &&
      Number.isSafeInteger(record.updatedAt)
    )
  ) {
    return false
  }
  // The row holds stored handles; validate the chain they decode to.
  const chain = decodePersistedAgentSessionProviderHandleChain(
    record.providerHandleChain,
    record.inactiveProviderHandleLinks,
    record.inactiveProviderHandleLinks ? record.providerContextBoundary?.afterFence : undefined
  )
  const head = chain?.at(-1)
  return (
    chain !== null &&
    (record.selectedProvider === undefined ||
      isAgentSessionProviderSelection(record.selectedProvider)) &&
    (record.providerSwitch === undefined || isAgentSessionProviderSwitch(record.providerSwitch)) &&
    (record.deferredProviderContext === undefined ||
      isDeferredProviderContext(record.deferredProviderContext)) &&
    (!head ||
      head.handle.agent === record.provider ||
      head.handle.agent === record.providerSwitch?.from.provider) &&
    (record.providerContextBoundary === undefined ||
      record.providerContextBoundary.afterFence <= record.lease.runtimeFence) &&
    (record.lease.claimStatus !== 'live' ||
      (record.lease.ownerProcess !== null &&
        // Null: the owner's process is live and its provider has not answered with a handle yet.
        (record.lease.provenHandleLinkId === null ||
          (head?.linkId === record.lease.provenHandleLinkId &&
            head.mintedAtFence === record.lease.runtimeFence))))
  )
}

function isAgentSessionProviderSelection(value: unknown): value is AgentSessionProviderSelection {
  if (!isStoredRecordObject(value)) {
    return false
  }
  const { agent, options, botDefault, consent } = value
  return (
    isStructuredAgentId(agent) &&
    (options === undefined || isAgentSessionOptions(options)) &&
    (botDefault === undefined || typeof botDefault === 'string') &&
    (consent === undefined ||
      (isStoredRecordObject(consent) &&
        isStructuredAgentId(consent.from) &&
        isAgentChatPermissionChoice(consent.fromPermission) &&
        (consent.hostRunId === undefined || typeof consent.hostRunId === 'string') &&
        isProviderSwitchCursor(consent.through)))
  )
}

function isProviderSwitchCursor(value: unknown): boolean {
  return (
    isStoredRecordObject(value) &&
    typeof value.epoch === 'string' &&
    isNonNegativeSafeInteger(value.sequence)
  )
}

function isAgentSessionProviderSwitch(value: unknown): value is AgentSessionProviderSwitch {
  if (!isStoredRecordObject(value)) {
    return false
  }
  const { from } = value
  return (
    typeof value.clientMessageId === 'string' &&
    typeof value.hostRunId === 'string' &&
    (value.fromLinkId === undefined || typeof value.fromLinkId === 'string') &&
    (value.retryHome === undefined || isAgentSessionProviderSelection(value.retryHome)) &&
    isProviderSwitchCursor(value.through) &&
    isStoredRecordObject(from) &&
    isStructuredAgentId(from.provider) &&
    isAgentSessionAccountHome(from.accountHome) &&
    (from.options === undefined || isAgentSessionOptions(from.options)) &&
    (from.permissionMode === undefined || typeof from.permissionMode === 'string') &&
    (from.launchArgs === undefined || isAgentSessionLaunchArgs(from.launchArgs)) &&
    (from.instructionsKey === undefined || typeof from.instructionsKey === 'string') &&
    (from.rewind === undefined || isAgentSessionRewindRecord(from.rewind))
  )
}

function isDeferredProviderContext(value: unknown): value is DeferredProviderContext {
  return (
    isStoredRecordObject(value) &&
    typeof value.marker === 'string' &&
    isStructuredAgentId(value.from) &&
    isProviderSwitchCursor(value.through) &&
    (value.clearKey === null || typeof value.clearKey === 'string') &&
    (value.attachedTo === undefined || typeof value.attachedTo === 'string')
  )
}

/** Writable records require the complete observation and a safe next-grant floor. */
export function isPersistedAgentSessionRecord(
  value: unknown
): value is PersistedAgentSessionRecord {
  if (!isPersistedAgentSessionObservationRecord(value)) {
    return false
  }
  const floor = value.lease.minimumNextFence
  if (value.providerSwitch) {
    const switchFloor = value.providerSwitchFenceFloor
    return floor === null && (switchFloor === undefined || isNonNegativeSafeInteger(switchFloor))
  }
  return (
    value.providerSwitchFenceFloor === undefined &&
    (floor === undefined || isNonNegativeSafeInteger(floor))
  )
}
