import { randomUUID } from 'node:crypto'
import { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'
export { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'
import type { PairingOffer } from './pairing'
import {
  getPreferredPairingOffer,
  RuntimeSshAccessOperationSchema,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment,
  type RuntimeSshAccessOperation,
  type RuntimeSshTunnelLink
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-file'
import {
  overlayRuntimeEnvironmentSidecar,
  readCurrentRuntimeEnvironmentSidecarEntry,
  runtimeEnvironmentSidecarBinding,
  writeRuntimeEnvironmentSidecarEntry,
  type RuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'

type SidecarState = Omit<RuntimeEnvironmentSidecarEntry, 'binding'>

type AccessContext = {
  environments: PersistedRuntimeEnvironment[]
  persisted: PersistedRuntimeEnvironment
  entry: SidecarState
  view: KnownRuntimeEnvironment
}

export function prepareRuntimeEnvironmentSshAccessLink(
  userDataPath: string,
  args: {
    expectedEnvironment: KnownRuntimeEnvironment
    requestId: string
    sshTargetId: string
    sshTargetGeneration: number
    remotePort: number
    targetFingerprint: string
  }
): KnownRuntimeEnvironment {
  const { expectedEnvironment: _expected, ...fields } = args
  const intent = RuntimeSshAccessOperationSchema.parse({ ...fields, operation: 'link' })
  const context = readAccessContext(userDataPath, args.expectedEnvironment, true)
  const existing = context.view
  if (existing.pendingSshAccessOperation) {
    requireMatchingIntent(existing, intent)
    return existing
  }
  if (existing.sshAccess) {
    throw invalid('This server already has SSH access.')
  }
  if (existing.connectionDependency) {
    throw invalid('Unlink the existing external tunnel before adding SSH access.')
  }
  return commit(userDataPath, context, { ...context.entry, pendingSshAccessOperation: intent })
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
  const views = readEnvironmentStore(userDataPath).environments
  const completed = views.find((entry) => entry.id === args.expectedEnvironment.id)
  if (completed?.sshAccess?.requestId && completed.sshAccess.requestId === args.requestId) {
    return requireMatchingCompletedLink(completed, args)
  }
  const context = readAccessContext(userDataPath, args.expectedEnvironment)
  const existing = context.view
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
    views.some((entry) => entry.id !== existing.id && entry.runtimeId === args.verifiedRuntimeId)
  ) {
    throw invalid(
      'This runtime is registered more than once. Reconcile its existing registrations first.'
    )
  }
  const endpointId = `ssh-${randomUUID()}`
  const { pendingSshAccessOperation: _intent, ...remaining } = context.entry
  return commit(userDataPath, context, {
    ...remaining,
    pairingRevisionFloor: nextPairingRevision(existing, args.now ?? Date.now()),
    runtimeId: args.verifiedRuntimeId,
    sshAccess: {
      ...args.tunnel,
      requestId: intent.requestId,
      targetFingerprint: intent.targetFingerprint,
      endpointId,
      previousPreferredEndpointId: existing.preferredEndpointId,
      endpoint: {
        id: endpointId,
        kind: 'websocket',
        label: 'SSH tunnel',
        endpoint: args.verifiedPairing.endpoint,
        publicKeyB64: offer.publicKeyB64,
        deviceToken: offer.deviceToken
      }
    }
  })
}

export function prepareRuntimeEnvironmentSshAccessUnlink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string; now?: number }
): KnownRuntimeEnvironment {
  const context = readAccessContext(userDataPath, args.expectedEnvironment)
  const existing = context.view
  if (existing.pendingSshAccessOperation) {
    if (
      existing.pendingSshAccessOperation.operation === 'unlink' &&
      existing.pendingSshAccessOperation.requestId === args.requestId
    ) {
      return existing
    }
    throw invalid('Another SSH access operation is pending.')
  }
  const sshAccess = existing.sshAccess
  if (!sshAccess) {
    throw invalid('This server does not have independently linked SSH access.')
  }
  const { sshAccess: _access, ...remaining } = context.entry
  return commit(userDataPath, context, {
    ...remaining,
    pairingRevisionFloor: nextPairingRevision(existing, args.now ?? Date.now()),
    pendingSshAccessOperation: {
      requestId: args.requestId,
      operation: 'unlink',
      sshTargetId: sshAccess.sshTargetId,
      sshTargetGeneration: sshAccess.sshTargetGeneration,
      remotePort: sshAccess.remotePort,
      targetFingerprint: sshAccess.targetFingerprint
    }
  })
}

export function completeRuntimeEnvironmentSshAccessUnlink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string }
): KnownRuntimeEnvironment {
  const context = readAccessContext(userDataPath, args.expectedEnvironment)
  const intent = context.view.pendingSshAccessOperation
  if (!intent || intent.operation !== 'unlink' || intent.requestId !== args.requestId) {
    throw invalid('SSH access completion does not match its pending unlink intent.')
  }
  const { pendingSshAccessOperation: _intent, ...remaining } = context.entry
  return commit(userDataPath, context, remaining)
}

export function cancelRuntimeEnvironmentSshAccessLink(
  userDataPath: string,
  args: { expectedEnvironment: KnownRuntimeEnvironment; requestId: string }
): KnownRuntimeEnvironment {
  const context = readAccessContext(userDataPath, args.expectedEnvironment)
  const intent = context.view.pendingSshAccessOperation
  if (!intent || intent.requestId !== args.requestId) {
    throw invalid('SSH access cancellation does not match its pending link intent.')
  }
  if (intent.operation === 'unlink') {
    return context.view
  }
  return commit(userDataPath, context, {
    ...context.entry,
    pendingSshAccessOperation: { ...intent, operation: 'unlink' }
  })
}

/** A retried completion must name exactly the link it already completed. */
function requireMatchingCompletedLink(
  completed: KnownRuntimeEnvironment,
  args: Parameters<typeof linkVerifiedRuntimeEnvironmentSshAccess>[1]
): KnownRuntimeEnvironment {
  const access = completed.sshAccess!
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

function readAccessContext(
  userDataPath: string,
  expected: KnownRuntimeEnvironment,
  ignoreIntent = false
): AccessContext {
  const { environments } = readPersistedEnvironmentStore(userDataPath)
  const views = readEnvironmentStore(userDataPath).environments
  const view = requireUnchangedEnvironment(views, expected, ignoreIntent)
  const persisted = environments.find((entry) => entry.id === view.id)!
  const current = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  const { binding: _binding, ...entry } = current ?? { binding: undefined }
  return { environments, persisted, entry, view }
}

/** Writes only after the overlay proves every requested field survives validation. */
function commit(
  userDataPath: string,
  context: AccessContext,
  next: SidecarState
): KnownRuntimeEnvironment {
  const view = overlayRuntimeEnvironmentSidecar(context.persisted, {
    ...next,
    binding: runtimeEnvironmentSidecarBinding(context.persisted)
  })
  if (
    (next.sshAccess !== undefined) !== (view.sshAccess !== undefined) ||
    (next.pendingSshAccessOperation !== undefined) !==
      (view.pendingSshAccessOperation !== undefined)
  ) {
    throw invalid('The SSH access state is inconsistent with this paired server.')
  }
  writeRuntimeEnvironmentSidecarEntry(userDataPath, context.environments, context.persisted, next)
  return view
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
