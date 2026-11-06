import type { PersistedUIState } from './persisted-ui-state-types'
import { normalizePersonalProjectOrder } from './personal-project-order'
import type {
  RecordProjectOpenRequest,
  SetProjectPinnedRequest
} from './rpc-contract/personal-project-order-params'

type ProjectOrderStore = {
  getUIState(): PersistedUIState
  updateUIState(updates: Partial<PersistedUIState>): PersistedUIState
}

export function mutatePersonalProjectOrder(
  store: ProjectOrderStore,
  request: RecordProjectOpenRequest | SetProjectPinnedRequest
): { ui: PersistedUIState; applied: boolean } {
  const ui = store.getUIState()
  const current = normalizePersonalProjectOrder(ui.personalProjectOrder)
  const operation = JSON.stringify([request.opId.writer, request.opId.seq])
  if (current.settledOperations.includes(operation)) {
    return { ui, applied: false }
  }
  const previous = current.projects[request.projectKey] ?? {}
  const isOpen = 'previousProjectKey' in request
  const applied = isOpen
    ? request.previousProjectKey !== request.projectKey
    : previous.pinned !== request.pinned
  let latestTimestamp = 0
  for (const entry of Object.values(current.projects)) {
    latestTimestamp = Math.max(latestTimestamp, entry.lastOpenedAt ?? 0)
  }
  const ownerNow = Date.now()
  const timestamp = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(Number.isFinite(ownerNow) ? Math.trunc(ownerNow) : 0, latestTimestamp + 1)
  )
  const preference = isOpen
    ? {
        ...previous,
        openCount: Math.min(Number.MAX_SAFE_INTEGER, (previous.openCount ?? 0) + 1),
        lastOpenedAt: timestamp
      }
    : { ...previous, pinned: request.pinned }
  return {
    applied,
    ui: store.updateUIState({
      personalProjectOrder: {
        revision: Math.min(Number.MAX_SAFE_INTEGER, (current.revision ?? 0) + 1),
        projects: applied
          ? { ...current.projects, [request.projectKey]: preference }
          : current.projects,
        settledOperations: [...current.settledOperations.slice(-4095), operation]
      }
    })
  }
}
