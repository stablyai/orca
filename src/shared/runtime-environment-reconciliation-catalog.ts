import { readEnvironmentStore, writeEnvironmentStore } from './runtime-environment-store-file'

/** Changes only catalog selection; transport, grant and storage ownership remain unchanged. */
export function setRuntimeEnvironmentReconciliationCatalogActive(
  userDataPath: string,
  args: { environmentId: string; requestId: string; active: boolean }
) {
  const store = readEnvironmentStore(userDataPath)
  const record = store.environments.find((entry) => entry.id === args.environmentId)?.reconciliation
  if (!record || record.requestId !== args.requestId) {
    throw new Error('The runtime reconciliation does not match this catalog transition.')
  }
  const stage = args.active ? ('catalog-active' as const) : ('prepared' as const)
  if (record.stage === stage) {
    return record
  }
  const next = { ...record, stage }
  writeEnvironmentStore(
    userDataPath,
    {
      ...store,
      environments: store.environments.map((environment) =>
        record.registrations.some((entry) => entry.environmentId === environment.id)
          ? { ...environment, reconciliation: next }
          : environment
      )
    },
    { transitionReconciliationCatalogRequestId: args.requestId }
  )
  return next
}
