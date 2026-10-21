import { useCallback, useState } from 'react'
import type { JiraUser } from '../../../shared/jira-types'

export function useJiraCreateAssignee(providerKey: string, projectKey: string) {
  const scope = JSON.stringify([providerKey, projectKey])
  const [selection, setSelection] = useState<{ scope: string; user: JiraUser | null }>({
    scope,
    user: null
  })
  // Reset during render so an implicit project change cannot submit the previous site's user.
  if (selection.scope !== scope) {
    setSelection({ scope, user: null })
  }
  const setNewJiraIssueAssignee = useCallback(
    (user: JiraUser | null) =>
      setSelection((current) => (current.scope === scope ? { scope, user } : current)),
    [scope]
  )
  return {
    newJiraIssueAssignee: selection.scope === scope ? selection.user : null,
    setNewJiraIssueAssignee
  }
}
