import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED,
  normalizeJiraQuickFilterState,
  type JiraQuickFilterState
} from '../../../shared/jira/jira-quick-filters'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export async function readJiraQuickFilterState(
  target: RuntimeClientTarget
): Promise<JiraQuickFilterState> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
      JIRA_STATUS_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraQuickFilterState(
      await callRuntimeRpc(target, 'ui.getJiraQuickFilters', undefined, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.getJiraQuickFilters) {
    throw new Error(JIRA_STATUS_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraQuickFilterState(await window.api.ui.getJiraQuickFilters())
}

export async function writeJiraQuickFilterState(
  target: RuntimeClientTarget,
  state: JiraQuickFilterState
): Promise<JiraQuickFilterState> {
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
      JIRA_STATUS_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraQuickFilterState(
      await callRuntimeRpc(target, 'ui.setJiraQuickFilters', state, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.setJiraQuickFilters) {
    throw new Error(JIRA_STATUS_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraQuickFilterState(await window.api.ui.setJiraQuickFilters(state))
}
