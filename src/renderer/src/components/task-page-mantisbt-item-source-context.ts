import type { MantisBTIssue, MantisBTSite } from '../../../shared/mantisbt-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export function bindTaskPageMantisBTItemSourceContext(args: {
  issue: MantisBTIssue
  sites: readonly MantisBTSite[]
  sourceContext: TaskSourceContext | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'mantisBT' || !args.issue.siteId) {
    return null
  }
  const site = args.sites.find((candidate) => candidate.id === args.issue.siteId)
  if (!site) {
    return null
  }
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'mantisBT',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectId: args.issue.project.id
    },
    accountLabel: site.displayName || site.siteUrl
  })
}
