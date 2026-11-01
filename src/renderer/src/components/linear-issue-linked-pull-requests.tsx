import React from 'react'
import { ExternalLink, GitPullRequest } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import type { LinearIssue } from '../../../shared/linear/issue-types'

export function LinearIssueLinkedPullRequests({
  issue
}: {
  issue: LinearIssue
}): React.JSX.Element | null {
  const pullRequests = issue.linkedPullRequests ?? []
  if (pullRequests.length === 0) {
    return null
  }

  return (
    <section className="mt-10 max-w-[820px]">
      <h2 className="mb-2 px-1.5 text-xs font-medium text-muted-foreground">
        {translate('auto.components.LinearIssueWorkspace.pullRequestsSection', 'Pull requests')}
      </h2>
      <div className="space-y-1">
        {pullRequests.map((pullRequest) => (
          <button
            key={pullRequest.id}
            type="button"
            onClick={() => window.api.shell.openUrl(pullRequest.url)}
            title={pullRequest.url}
            className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitPullRequest className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{pullRequest.title}</span>
            {pullRequest.subtitle ? (
              <span className="shrink-0 truncate text-xs">{pullRequest.subtitle}</span>
            ) : null}
            <ExternalLink className="size-3.5 shrink-0" />
          </button>
        ))}
      </div>
    </section>
  )
}
