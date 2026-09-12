import { createHash } from 'node:crypto'
import {
  getPreferredPairingOffer,
  KnownRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'

export function runtimeEnvironmentReconciliationAuthorityDigest(
  input: KnownRuntimeEnvironment
): string {
  const environment = KnownRuntimeEnvironmentSchema.parse(input)
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: environment.id,
        source: environment.source,
        binding: runtimeEnvironmentSshAccessBinding(environment)
      })
    )
    .digest('hex')
}

export function validateRuntimeEnvironmentReconciliations(store: RuntimeEnvironmentStore): void {
  const requests = new Map<string, string>()
  for (const environment of store.environments) {
    const record = environment.reconciliation
    if (!record) {
      continue
    }
    const serialized = JSON.stringify(record)
    const prior = requests.get(record.requestId)
    if (prior !== undefined && prior !== serialized) {
      throw new Error('Runtime reconciliation request has conflicting records.')
    }
    requests.set(record.requestId, serialized)
    const ids = record.registrations.map((entry) => entry.environmentId)
    if (
      (store.version !== 3 && store.version !== 4) ||
      (record.stage === 'catalog-active' && store.version !== 4) ||
      new Set(ids).size !== 2 ||
      !ids.includes(environment.id) ||
      !ids.includes(record.canonicalEnvironmentId)
    ) {
      throw new Error('Invalid runtime reconciliation membership.')
    }
    const key = getPreferredPairingOffer(environment).publicKeyB64
    for (const binding of record.registrations) {
      const matches = store.environments.filter((entry) => entry.id === binding.environmentId)
      const participant = matches[0]
      if (
        matches.length !== 1 ||
        JSON.stringify(participant.reconciliation) !== JSON.stringify(record) ||
        runtimeEnvironmentReconciliationAuthorityDigest(participant) !== binding.authorityDigest ||
        (participant.runtimeId !== null && participant.runtimeId !== record.runtimeId) ||
        getPreferredPairingOffer(participant).publicKeyB64 !== key
      ) {
        throw new Error('Runtime reconciliation registration authority changed or is missing.')
      }
    }
  }
}

export function preserveRuntimeEnvironmentReconciliations(
  previous: RuntimeEnvironmentStore,
  next: RuntimeEnvironmentStore,
  cancelPreparedRequestId?: string,
  transitionCatalogRequestId?: string
): void {
  for (const environment of previous.environments) {
    const replacement = next.environments.find((entry) => entry.id === environment.id)
    if (
      environment.reconciliation &&
      replacement?.reconciliation &&
      environment.reconciliation.requestId === transitionCatalogRequestId &&
      JSON.stringify({ ...environment.reconciliation, stage: replacement.reconciliation.stage }) ===
        JSON.stringify(replacement.reconciliation)
    ) {
      continue
    }
    if (
      environment.reconciliation?.requestId === cancelPreparedRequestId &&
      environment.reconciliation?.stage === 'prepared' &&
      replacement &&
      !replacement.reconciliation &&
      runtimeEnvironmentReconciliationAuthorityDigest(replacement) ===
        runtimeEnvironmentReconciliationAuthorityDigest(environment)
    ) {
      continue
    }
    if (
      environment.reconciliation &&
      JSON.stringify(replacement?.reconciliation) !== JSON.stringify(environment.reconciliation)
    ) {
      throw new Error(
        'Resolve the pending runtime reconciliation before changing its registrations.'
      )
    }
  }
}
