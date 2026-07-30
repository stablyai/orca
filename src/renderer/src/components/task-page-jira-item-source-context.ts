import type { JiraIssue, JiraSite } from '../../../shared/types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export function bindTaskPageJiraItemSourceContext(args: {
  issue: JiraIssue
  sites: readonly JiraSite[]
  sourceContext: TaskSourceContext | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'jira' || !args.issue.siteId) {
    return null
  }
  const site = args.sites.find((candidate) => candidate.id === args.issue.siteId)
  if (!site) {
    return null
  }
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'jira',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectKey: args.issue.project.key
    },
    accountLabel: site.email || site.displayName || site.siteUrl
  })
}
