import type { PreloadApi } from '../../../../preload/api-types'
import {
  JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
  JIRA_SAVED_FILTER_UPDATE_REQUIRED
} from '../../../../shared/jira/jira-saved-filter-capability'
import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED,
  type JiraQuickFilterState
} from '../../../../shared/jira-quick-filters'
import type { RuntimeCapability } from '../../../../shared/protocol-version'
import type { JiraSavedFilterState } from '../../../../shared/jira/jira-saved-filters'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'
import { assertActiveEnvironment, requireActiveEnvironment } from './web-runtime-session'

type WebJiraFilterStateApi = Pick<
  NonNullable<Partial<PreloadApi>['ui']>,
  'getJiraQuickFilters' | 'setJiraQuickFilters' | 'getJiraSavedFilters' | 'mutateJiraSavedFilters'
>

const JIRA_FILTER_TIMEOUT_MS = 15_000

/** Calls the active host only when it advertises the method, so an older host reports "update required" instead of failing generically. */
async function callJiraFilterMethod<TResult>(
  capability: RuntimeCapability,
  updateRequired: string,
  method: string,
  params?: unknown
): Promise<TResult> {
  const environmentId = requireActiveEnvironment().id
  const status = await getRemoteRuntimeStatus()
  // Why: the capability verdict belongs to the probed host; never send to a host switched in mid-probe.
  assertActiveEnvironment(environmentId)
  if (!status.capabilities?.includes(capability)) {
    throw new Error(updateRequired)
  }
  return callRuntimeResult<TResult>(method, params, JIRA_FILTER_TIMEOUT_MS)
}

/** Jira filter state lives on the paired host, which is the web client's local execution target. */
export function createWebJiraFilterStateApi(): WebJiraFilterStateApi {
  return {
    getJiraQuickFilters: () =>
      callJiraFilterMethod<JiraQuickFilterState>(
        JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
        JIRA_STATUS_FILTER_UPDATE_REQUIRED,
        'ui.getJiraQuickFilters'
      ),
    setJiraQuickFilters: (state) =>
      callJiraFilterMethod<JiraQuickFilterState>(
        JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
        JIRA_STATUS_FILTER_UPDATE_REQUIRED,
        'ui.setJiraQuickFilters',
        state
      ),
    getJiraSavedFilters: () =>
      callJiraFilterMethod<JiraSavedFilterState>(
        JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
        JIRA_SAVED_FILTER_UPDATE_REQUIRED,
        'ui.getJiraSavedFilters'
      ),
    mutateJiraSavedFilters: (mutation) =>
      callJiraFilterMethod<JiraSavedFilterState>(
        JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
        JIRA_SAVED_FILTER_UPDATE_REQUIRED,
        'ui.mutateJiraSavedFilters',
        mutation
      )
  }
}
