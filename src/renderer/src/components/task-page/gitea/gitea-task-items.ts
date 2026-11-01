import type { GiteaIssueInfo, GiteaWorkItem } from '../../../../../shared/gitea-types'

export function giteaIssueToWorkItem(issue: GiteaIssueInfo, repoId: string): GiteaWorkItem {
  return {
    id: `issue:${issue.number}`,
    type: 'issue',
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    labels: issue.labels,
    updatedAt: issue.updatedAt,
    author: issue.author,
    repoId
  }
}
