import type { JiraSlice, JiraSliceSet } from './jira-slice-contract'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import { getJiraReadIdentity } from './jira-read-coordination'

export function createJiraIssuePatchAction(set: JiraSliceSet): Pick<JiraSlice, 'patchJiraIssue'> {
  return {
    patchJiraIssue: (issueKey, patch, options) => {
      const siteId = options?.siteId ?? patch.siteId
      const matchesIssue = (issue: JiraIssue | null | undefined): boolean =>
        issue?.key === issueKey && (siteId == null || issue.siteId === siteId)
      set((state) => {
        const scope = getJiraReadIdentity(state.settings, options?.sourceContext)
        if (
          !scope.explicitSource &&
          options?.contextKey &&
          options.contextKey !== scope.contextKey
        ) {
          return state
        }
        const canPatchCacheKey = (key: string): boolean =>
          scope.cachePrefix ? key.startsWith(`${scope.cachePrefix}::`) : !key.startsWith('jira:')
        let changed = false
        const jiraIssueCache = { ...state.jiraIssueCache }
        for (const [key, entry] of Object.entries(jiraIssueCache)) {
          if (!canPatchCacheKey(key) || !entry?.data || !matchesIssue(entry.data)) {
            continue
          }
          jiraIssueCache[key] = { ...entry, data: { ...entry.data, ...patch }, fetchedAt: 0 }
          changed = true
        }
        const jiraSearchCache = { ...state.jiraSearchCache }
        for (const [key, entry] of Object.entries(jiraSearchCache)) {
          if (!canPatchCacheKey(key) || !entry?.data) {
            continue
          }
          const index = entry.data.findIndex(matchesIssue)
          if (index === -1) {
            continue
          }
          const updatedIssues = [...entry.data]
          updatedIssues[index] = { ...updatedIssues[index], ...patch }
          jiraSearchCache[key] = { ...entry, data: updatedIssues }
          changed = true
        }
        return changed ? { jiraIssueCache, jiraSearchCache } : state
      })
    }
  }
}
