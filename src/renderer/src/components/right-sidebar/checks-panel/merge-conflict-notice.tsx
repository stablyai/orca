import React from 'react'
import type { PRMergeableState } from '../../../../../shared/github/pull-request-types'
import type { HostedReviewProvider } from '../../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'

export type ConflictReview = {
  mergeable: PRMergeableState
}

function getMergeConflictNoticeCopy(
  provider: HostedReviewProvider,
  baseRefName: string | undefined
): { title: string; body: string } {
  if (provider === 'gitlab') {
    return {
      title: translate(
        'checksPanel.mergeConflict.gitLabTitle',
        'GitLab reports conflicts with the target branch'
      ),
      body: translate(
        'checksPanel.mergeConflict.gitLabBody',
        'Merge the target branch into this branch to see and resolve the conflicting files.'
      )
    }
  }
  if (!baseRefName) {
    return {
      title: translate(
        'checksPanel.mergeConflict.gitHubTitleNoBase',
        'GitHub reports conflicts with the base branch'
      ),
      body: translate(
        'checksPanel.mergeConflict.gitHubBodyNoBase',
        'Merge the base branch into this branch to see and resolve the conflicting files.'
      )
    }
  }
  return {
    title: translate(
      'checksPanel.mergeConflict.gitHubTitle',
      'GitHub reports conflicts with {{baseRefName}}',
      { baseRefName }
    ),
    body: translate(
      'checksPanel.mergeConflict.gitHubBody',
      'Merge {{baseRefName}} into this branch to see and resolve the conflicting files.',
      { baseRefName }
    )
  }
}

// Why: the host only reports that conflicts exist; Git lists the files once the merge runs in this worktree.
export function MergeConflictNotice({
  provider,
  baseRefName
}: {
  provider: HostedReviewProvider
  baseRefName: string | undefined
}): React.JSX.Element {
  const { title, body } = getMergeConflictNoticeCopy(provider, baseRefName)
  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">{title}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{body}</div>
    </div>
  )
}
