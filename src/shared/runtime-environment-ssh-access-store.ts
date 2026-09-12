import { randomUUID } from 'node:crypto'
import { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'
export { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'
import type { PairingOffer } from './pairing'
import {
  KnownRuntimeEnvironmentSchema,
  getPreferredPairingOffer,
  getRuntimeSshAccess,
  RuntimeSshAccessOperationSchema,
  type KnownRuntimeEnvironment,
  type RuntimeSshAccessOperation,
  type RuntimeSshTunnelLink
} from './runtime-environments'
import {
  readEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStore
} from './runtime-environment-store-file'

export function prepareRuntimeEnvironmentSshAccessLink(
  userDataPath: string,
  args: {
    expectedEnvironment: KnownRuntimeEnvironment
    requestId: string
    sshTargetId: string
    sshTargetGeneration: number
    remotePort: number
    targetFingerprint: string
    now?: number
  }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const intent = RuntimeSshAccessOperationSchema.parse({ ...args, operation: 'link' })
  const existing = requireUnchangedEnvironment(store.environments, args.expectedEnvironment, true)
  if (existing.pendingSshAccessOperation) {
    requireMatchingIntent(existing, intent)
    return existing
  }
  if (getRuntimeSshAccess(existing)) {
    throw invalid('This server already has SSH access.')
  }
  if (existing.connectionDependency) {
    throw invalid('Unlink the existing external tunnel before adding SSH access.')
  }
  const next = KnownRuntimeEnvironmentSchema.parse({
    ...existing,
    pendingSshAccessOperation: intent,
    updatedAt: args.now ?? Date.now()
  })
  writeReplacement(userDataPath, store.environments, next)
  return next
}

export function linkVerifiedRuntimeEnvironmentSshAccess(
  userDataPath: string,
  args: {
    expectedEnvironment: KnownRuntimeEnvironment
    requestId: string
    verifiedRuntimeId: string
    verifiedPairing: PairingOffer
    tunnel: RuntimeSshTunnelLink
    now?: number
  }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const completed = store.environments.find((entry) => entry.id === args.expectedEnvironment.id)
  if (completed?.sshAccess?.requestId && completed.sshAccess.requestId === args.requestId) {
    const access = completed.sshAccess
    const expectedIntent = args.expectedEnvironment.pendingSshAccessOperation
    const prior = expectedIntent
      ? {
          ...completed,
          runtimeId: args.expectedEnvironment.runtimeId,
          pairingRevision: args.expectedEnvironment.pairingRevision,
          sshAccess: undefined,
          connectionDependency: undefined,
          pendingSshAccessOperation: expectedIntent,
          preferredEndpointId: access.previousPreferredEndpointId,
          endpoints: completed.endpoints.filter((entry) => entry.id !== access.endpointId)
        }
      : completed
    requireUnchangedEnvironment([prior], args.expectedEnvironment)
    const offer = getPreferredPairingOffer(completed)
    if (
      completed.runtimeId !== args.verifiedRuntimeId ||
      offer.endpoint !== args.verifiedPairing.endpoint ||
      offer.deviceToken !== args.verifiedPairing.deviceToken ||
      offer.publicKeyB64 !== args.verifiedPairing.publicKeyB64 ||
      offer.pairedDeviceId !== args.verifiedPairing.pairedDeviceId ||
      access.sshTargetId !== args.tunnel.sshTargetId ||
      access.sshTargetGeneration !== args.tunnel.sshTargetGeneration ||
      access.localPort !== args.tunnel.localPort ||
      access.remotePort !== args.tunnel.remotePort ||
      (expectedIntent &&
        (expectedIntent.operation !== 'link' ||
          expectedIntent.requestId !== args.requestId ||
          expectedIntent.targetFingerprint !== access.targetFingerprint))
    ) {
      throw invalid('SSH access retry does not match its completed link.')
    }
    return completed
  }
  const existing = requireUnchangedEnvironment(store.environments, args.expectedEnvironment)
  const intent = existing.pendingSshAccessOperation
  if (
    !intent ||
    intent.operation !== 'link' ||
    intent.requestId !== args.requestId ||
    intent.sshTargetId !== args.tunnel.sshTargetId ||
    intent.sshTargetGeneration !== args.tunnel.sshTargetGeneration ||
    intent.remotePort !== args.tunnel.remotePort
  ) {
    throw invalid('SSH access completion does not match its pending link intent.')
  }
  const offer = getPreferredPairingOffer(existing)
  if (
    !args.verifiedRuntimeId.trim() ||
    (existing.runtimeId !== null && existing.runtimeId !== args.verifiedRuntimeId) ||
    args.verifiedPairing.publicKeyB64 !== offer.publicKeyB64 ||
    args.verifiedPairing.deviceToken !== offer.deviceToken ||
    args.verifiedPairing.pairedDeviceId !== offer.pairedDeviceId
  ) {
    throw invalid('The SSH endpoint did not verify as this paired server.')
  }
  if (
    store.environments.some(
      (entry) => entry.id !== existing.id && entry.runtimeId === args.verifiedRuntimeId
    )
  ) {
    throw invalid(
      'This runtime is registered more than once. Reconcile its existing registrations first.'
    )
  }
  const endpointId = `ssh-${randomUUID()}`
  const now = args.now ?? Date.now()
  const next = KnownRuntimeEnvironmentSchema.parse({
    ...existing,
    pendingSshAccessOperation: undefined,
    runtimeId: args.verifiedRuntimeId,
    updatedAt: now,
    pairingRevision: nextPairingRevision(existing, now),
    connectionDependency: 'ssh-tunnel',
    sshAccess: {
      ...args.tunnel,
      requestId: intent.requestId,
      targetFingerprint: intent.targetFingerprint,
      endpointId,
      previousPreferredEndpointId: existing.preferredEndpointId
    },
    endpoints: [
      ...existing.endpoints,
      {
        id: endpointId,
        kind: 'websocket',
        label: 'SSH tunnel',
        endpoint: args.verifiedPairing.endpoint,
        publicKeyB64: offer.publicKeyB64,
        deviceToken: offer.deviceToken
      }
    ],
    preferredEndpointId: endpointId
  })
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.map((entry) => (entry.id === existing.id ? next : entry))
  })
  return next
}

export function prepareRuntimeEnvironmentSshAccessUnlink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string; now?: number }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const existing = requireUnchangedEnvironment(store.environments, args.expectedEnvironment)
  if (existing.pendingSshAccessOperation) {
    if (
      existing.pendingSshAccessOperation.operation === 'unlink' &&
      existing.pendingSshAccessOperation.requestId === args.requestId
    ) {
      return existing
    }
    throw invalid('Another SSH access operation is pending.')
  }
  if (existing.orcadDeployment || !existing.sshAccess) {
    throw invalid('This server does not have independently linked SSH access.')
  }
  const { sshAccess, connectionDependency: _dependency, ...remaining } = existing
  const now = args.now ?? Date.now()
  const next = KnownRuntimeEnvironmentSchema.parse({
    ...remaining,
    updatedAt: now,
    pairingRevision: nextPairingRevision(existing, now),
    pendingSshAccessOperation: {
      requestId: args.requestId,
      operation: 'unlink',
      sshTargetId: sshAccess.sshTargetId,
      sshTargetGeneration: sshAccess.sshTargetGeneration,
      remotePort: sshAccess.remotePort,
      targetFingerprint: sshAccess.targetFingerprint
    },
    preferredEndpointId: sshAccess.previousPreferredEndpointId,
    endpoints: existing.endpoints.filter((entry) => entry.id !== sshAccess.endpointId)
  })
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.map((entry) => (entry.id === existing.id ? next : entry))
  })
  return next
}

export function completeRuntimeEnvironmentSshAccessUnlink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const existing = requireUnchangedEnvironment(store.environments, args.expectedEnvironment)
  const intent = existing.pendingSshAccessOperation
  if (!intent || intent.operation !== 'unlink' || intent.requestId !== args.requestId) {
    throw invalid('SSH access completion does not match its pending unlink intent.')
  }
  const { pendingSshAccessOperation: _intent, ...next } = existing
  writeReplacement(userDataPath, store.environments, next)
  return next
}

export function cancelRuntimeEnvironmentSshAccessLink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string }
): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const existing = requireUnchangedEnvironment(store.environments, args.expectedEnvironment)
  const intent = existing.pendingSshAccessOperation
  if (!intent || intent.requestId !== args.requestId) {
    throw invalid('SSH access cancellation does not match its pending link intent.')
  }
  if (intent.operation === 'unlink') {
    return existing
  }
  const next = KnownRuntimeEnvironmentSchema.parse({
    ...existing,
    pendingSshAccessOperation: { ...intent, operation: 'unlink' }
  })
  writeReplacement(userDataPath, store.environments, next)
  return next
}

function writeReplacement(
  userDataPath: string,
  environments: KnownRuntimeEnvironment[],
  next: KnownRuntimeEnvironment
): void {
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: environments.map((entry) => (entry.id === next.id ? next : entry))
  })
}

function requireMatchingIntent(
  environment: KnownRuntimeEnvironment,
  intent: RuntimeSshAccessOperation
): void {
  if (JSON.stringify(environment.pendingSshAccessOperation) !== JSON.stringify(intent)) {
    throw invalid('Another SSH access operation is pending.')
  }
}

function requireUnchangedEnvironment(
  environments: KnownRuntimeEnvironment[],
  expected: KnownRuntimeEnvironment,
  ignoreIntent = false
): KnownRuntimeEnvironment {
  const existing = environments.find((entry) => entry.id === expected.id)
  if (
    !existing ||
    JSON.stringify(runtimeEnvironmentSshAccessBinding(existing, ignoreIntent)) !==
      JSON.stringify(runtimeEnvironmentSshAccessBinding(expected, ignoreIntent))
  ) {
    throw invalid(
      'The paired server changed while SSH access was being verified. Retry with its current pairing.'
    )
  }
  return existing
}

function nextPairingRevision(environment: KnownRuntimeEnvironment, now: number): number {
  return Math.max(now, (environment.pairingRevision ?? environment.createdAt) + 1)
}

function invalid(message: string): RuntimeEnvironmentStoreError {
  return new RuntimeEnvironmentStoreError('invalid_argument', message)
}
