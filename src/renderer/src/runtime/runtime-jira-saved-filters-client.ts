import type { JiraSavedFilter, JiraSiteSelection } from '../../../shared/types'
import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function jiraListSavedFilters(
  settings: RuntimeJiraSettings,
  siteId?: JiraSiteSelection | null
): Promise<JiraSavedFilter[]> {
  const target = getJiraRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.jira.listSavedFilters(siteId ? { siteId } : undefined)
  }
  try {
    return await callRuntimeRpc<JiraSavedFilter[]>(
      target,
      'jira.listSavedFilters',
      siteId ? { siteId } : undefined,
      { timeoutMs: 30_000 }
    )
  } catch (error) {
    // Older remote hosts predate saved filters; hide them instead of failing the panel.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return []
    }
    throw error
  }
}
