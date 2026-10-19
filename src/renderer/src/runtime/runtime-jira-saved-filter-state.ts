import {
  normalizeJiraSavedFilterState,
  type JiraSavedFilterState,
  type JiraSavedFilterMutation
} from '../../../shared/jira-saved-filters'
import {
  JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
  JIRA_SAVED_FILTER_UPDATE_REQUIRED
} from '../../../shared/jira-saved-filter-capability'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export async function readJiraSavedFilterState(
  target: RuntimeClientTarget
): Promise<JiraSavedFilterState> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
      JIRA_SAVED_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraSavedFilterState(
      await callRuntimeRpc(target, 'ui.getJiraSavedFilters', undefined, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.getJiraSavedFilters) {
    throw new Error(JIRA_SAVED_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraSavedFilterState(await window.api.ui.getJiraSavedFilters())
}

export async function mutateJiraSavedFilters(
  target: RuntimeClientTarget,
  mutation: JiraSavedFilterMutation
): Promise<JiraSavedFilterState> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
      JIRA_SAVED_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraSavedFilterState(
      await callRuntimeRpc(target, 'ui.mutateJiraSavedFilters', mutation, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.mutateJiraSavedFilters) {
    throw new Error(JIRA_SAVED_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraSavedFilterState(await window.api.ui.mutateJiraSavedFilters(mutation))
}
