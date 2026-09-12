import { readEnvironmentStore, writeEnvironmentStore } from './runtime-environment-store-file'
import { runtimeEnvironmentReconciliationAuthorityDigest } from './runtime-environment-reconciliation-integrity'
import { RuntimeEnvironmentReconciliationRecordSchema } from './runtime-environment-reconciliation-record'
import type { KnownRuntimeEnvironment } from './runtime-environments'

export function prepareRuntimeEnvironmentReconciliation(
  userDataPath: string,
  args: {
    requestId: string
    canonicalEnvironmentId: string
    verifiedRuntimeId: string
    expectedRegistrations: readonly KnownRuntimeEnvironment[]
    now?: number
  }
) {
  const store = readEnvironmentStore(userDataPath)
  const bindings = args.expectedRegistrations
    .map((environment) => ({
      environmentId: environment.id,
      authorityDigest: runtimeEnvironmentReconciliationAuthorityDigest(environment)
    }))
    .sort((a, b) => a.environmentId.localeCompare(b.environmentId))
  const record = RuntimeEnvironmentReconciliationRecordSchema.parse({
    version: 1,
    stage: 'prepared',
    requestId: args.requestId,
    canonicalEnvironmentId: args.canonicalEnvironmentId,
    runtimeId: args.verifiedRuntimeId,
    registrations: bindings,
    preparedAt: args.now ?? Date.now()
  })
  for (const binding of bindings) {
    const current = store.environments.find((entry) => entry.id === binding.environmentId)
    if (
      !current ||
      runtimeEnvironmentReconciliationAuthorityDigest(current) !== binding.authorityDigest
    ) {
      throw new Error('Runtime registration changed before reconciliation could be prepared.')
    }
    if (current.reconciliation) {
      if (
        JSON.stringify({ ...current.reconciliation, preparedAt: record.preparedAt }) !==
        JSON.stringify(record)
      ) {
        throw new Error('Another runtime reconciliation is already prepared.')
      }
      return current.reconciliation
    }
  }
  writeEnvironmentStore(userDataPath, {
    version: 3,
    environments: store.environments.map((environment) =>
      bindings.some((binding) => binding.environmentId === environment.id)
        ? { ...environment, reconciliation: record }
        : environment
    )
  })
  return record
}

export function cancelPreparedRuntimeEnvironmentReconciliation(
  userDataPath: string,
  args: { environmentId: string; requestId: string }
): void {
  const store = readEnvironmentStore(userDataPath)
  const record = store.environments.find((entry) => entry.id === args.environmentId)?.reconciliation
  if (!record || record.requestId !== args.requestId || record.stage !== 'prepared') {
    throw new Error('The pending runtime reconciliation does not match this cancellation.')
  }
  writeEnvironmentStore(
    userDataPath,
    {
      ...store,
      environments: store.environments.map((environment) => {
        if (!record.registrations.some((entry) => entry.environmentId === environment.id)) {
          return environment
        }
        const { reconciliation: _record, ...remaining } = environment
        return remaining
      })
    },
    { cancelPreparedReconciliationRequestId: args.requestId }
  )
}
