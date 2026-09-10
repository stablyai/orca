import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import { isPtyIncarnationId, type PtyIncarnationId } from './pty-incarnation'

export const PTY_STOP_RECEIPT_VERSION = 1 as const
export const PTY_STOP_RECEIPT_CAPABILITY_VERSION = 1 as const

export type PtyStopProcessIdentity = {
  pid: number | null
  parentPid: number | null
  processGroupId: number | null
  startedAt: string | null
}

export type PtyStopProcessObservation = {
  identity: PtyStopProcessIdentity
  status: 'absent' | 'live' | 'unverifiable'
  observedAt: string
}

type PtyStopReceiptBase = {
  version: typeof PTY_STOP_RECEIPT_VERSION
  capabilityVersion: typeof PTY_STOP_RECEIPT_CAPABILITY_VERSION
  executionHostId: ExecutionHostId
  terminalHandle: string
  ptyId: string
  ptyIncarnation: PtyIncarnationId
  root: PtyStopProcessIdentity
  descendants: PtyStopProcessIdentity[]
  observations: PtyStopProcessObservation[]
  timestamp: string
}

export type PtyStopReceipt = PtyStopReceiptBase &
  (
    | { verdict: 'exited'; processTreeVerified: true }
    | {
        verdict: 'live' | 'unverifiable' | 'capability_limited'
        processTreeVerified: false
        reason: string
      }
  )

export type PtyStopReceiptExpectation = {
  executionHostId?: ExecutionHostId
  terminalHandle?: string
  ptyId?: string
  ptyIncarnation?: PtyIncarnationId
}

export function ptyStopReceiptProvesExit(
  receipt: PtyStopReceipt | null | undefined
): receipt is Extract<PtyStopReceipt, { verdict: 'exited' }> {
  return receipt?.verdict === 'exited' && receipt.processTreeVerified
}

export function createPtyStopReceipt(
  params: Omit<PtyStopReceiptBase, 'version' | 'capabilityVersion' | 'timestamp'> &
    Pick<PtyStopReceipt, 'verdict' | 'processTreeVerified'> & { reason?: string }
): PtyStopReceipt {
  return parsePtyStopReceipt({
    version: PTY_STOP_RECEIPT_VERSION,
    capabilityVersion: PTY_STOP_RECEIPT_CAPABILITY_VERSION,
    ...params,
    timestamp: new Date().toISOString()
  })
}

export function parsePtyStopReceipt(
  value: unknown,
  expected: PtyStopReceiptExpectation = {}
): PtyStopReceipt {
  if (!isRecord(value)) {
    throw new Error('pty_stop_receipt_malformed')
  }
  const executionHostId = normalizeExecutionHostId(readString(value, 'executionHostId'))
  const terminalHandle = readString(value, 'terminalHandle')
  const ptyId = readString(value, 'ptyId')
  const ptyIncarnation = readString(value, 'ptyIncarnation')
  const verdict = value.verdict
  const timestamp = readTimestamp(value, 'timestamp')
  if (
    value.version !== PTY_STOP_RECEIPT_VERSION ||
    value.capabilityVersion !== PTY_STOP_RECEIPT_CAPABILITY_VERSION ||
    !executionHostId ||
    !terminalHandle ||
    !ptyId ||
    !isPtyIncarnationId(ptyIncarnation) ||
    !isPtyStopVerdict(verdict)
  ) {
    throw new Error('pty_stop_receipt_malformed')
  }
  const root = parseProcessIdentity(value.root)
  const descendants = parseIdentityArray(value.descendants)
  const observations = parseObservationArray(value.observations)
  const processTreeVerified = value.processTreeVerified === true
  const reason = typeof value.reason === 'string' && value.reason.trim() ? value.reason : null
  if (
    (expected.executionHostId !== undefined && expected.executionHostId !== executionHostId) ||
    (expected.terminalHandle !== undefined && expected.terminalHandle !== terminalHandle) ||
    (expected.ptyId !== undefined && expected.ptyId !== ptyId) ||
    (expected.ptyIncarnation !== undefined && expected.ptyIncarnation !== ptyIncarnation)
  ) {
    throw new Error('pty_stop_receipt_identity_mismatch')
  }
  const identities = [root, ...descendants]
  if (!observationsMatchIdentities(observations, identities)) {
    throw new Error('pty_stop_receipt_observation_mismatch')
  }
  if (verdict === 'exited') {
    if (
      !processTreeVerified ||
      reason ||
      identities.some(({ pid, startedAt }) => pid === null || startedAt === null) ||
      observations.some(({ status }) => status !== 'absent')
    ) {
      throw new Error('pty_stop_receipt_exit_unverified')
    }
  } else if (processTreeVerified || !reason) {
    throw new Error('pty_stop_receipt_verdict_malformed')
  }
  if (verdict === 'live' && !observations.some(({ status }) => status === 'live')) {
    throw new Error('pty_stop_receipt_live_unobserved')
  }
  const common = {
    version: PTY_STOP_RECEIPT_VERSION,
    capabilityVersion: PTY_STOP_RECEIPT_CAPABILITY_VERSION,
    executionHostId,
    terminalHandle,
    ptyId,
    ptyIncarnation,
    root,
    descendants,
    observations,
    timestamp
  }
  if (verdict === 'exited') {
    return { ...common, verdict, processTreeVerified: true }
  }
  if (!reason) {
    throw new Error('pty_stop_receipt_verdict_malformed')
  }
  return { ...common, verdict, processTreeVerified: false, reason }
}

function parseIdentityArray(value: unknown): PtyStopProcessIdentity[] {
  if (!Array.isArray(value)) {
    throw new Error('pty_stop_receipt_malformed')
  }
  return value.map(parseProcessIdentity)
}

function parseObservationArray(value: unknown): PtyStopProcessObservation[] {
  if (!Array.isArray(value)) {
    throw new Error('pty_stop_receipt_malformed')
  }
  return value.map((candidate) => {
    if (!isRecord(candidate) || !isObservationStatus(candidate.status)) {
      throw new Error('pty_stop_receipt_malformed')
    }
    return {
      identity: parseProcessIdentity(candidate.identity),
      status: candidate.status,
      observedAt: readTimestamp(candidate, 'observedAt')
    }
  })
}

function parseProcessIdentity(value: unknown): PtyStopProcessIdentity {
  if (!isRecord(value)) {
    throw new Error('pty_stop_receipt_malformed')
  }
  const pid = readNullablePositiveInteger(value.pid)
  const parentPid = readNullableInteger(value.parentPid, false)
  const processGroupId = readNullableInteger(value.processGroupId, false)
  const startedAt = value.startedAt === null ? null : readString(value, 'startedAt')
  if (startedAt === '') {
    throw new Error('pty_stop_receipt_malformed')
  }
  return { pid, parentPid, processGroupId, startedAt }
}

function observationsMatchIdentities(
  observations: readonly PtyStopProcessObservation[],
  identities: readonly PtyStopProcessIdentity[]
): boolean {
  if (observations.length !== identities.length) {
    return false
  }
  const expected = new Set(identities.map(processIdentityKey))
  return (
    observations.every(({ identity }) => expected.delete(processIdentityKey(identity))) &&
    expected.size === 0
  )
}

function processIdentityKey(identity: PtyStopProcessIdentity): string {
  return `${identity.pid}\0${identity.parentPid ?? ''}\0${identity.processGroupId ?? ''}\0${identity.startedAt ?? ''}`
}

function readNullablePositiveInteger(value: unknown): number | null {
  return readNullableInteger(value, true)
}

function readNullableInteger(value: unknown, positive: boolean): number | null {
  if (value === null) {
    return null
  }
  if (!Number.isInteger(value) || (positive && Number(value) <= 0)) {
    throw new Error('pty_stop_receipt_malformed')
  }
  return Number(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === 'string' ? record[key].trim() : ''
}

function readTimestamp(record: Record<string, unknown>, key: string): string {
  const value = readString(record, key)
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error('pty_stop_receipt_malformed')
  }
  return value
}

function isPtyStopVerdict(value: unknown): value is PtyStopReceipt['verdict'] {
  return ['exited', 'live', 'unverifiable', 'capability_limited'].includes(String(value))
}

function isObservationStatus(value: unknown): value is PtyStopProcessObservation['status'] {
  return ['absent', 'live', 'unverifiable'].includes(String(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
