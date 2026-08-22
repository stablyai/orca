import React from 'react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  getBeadsListNoticeCopy,
  type TaskPageBeadsRepoNotice
} from './task-page-beads-list-notices'

type BeadsRepoNoticeRowsProps = {
  notices: readonly TaskPageBeadsRepoNotice[]
  onRetry: () => void
  repoBadges: ReadonlyMap<string, { displayName: string }>
  selectedRepoCount: number
}

function BeadsRepoNoticeRow({
  notice,
  onRetry,
  repoBadges
}: {
  notice: TaskPageBeadsRepoNotice
  onRetry: () => void
  repoBadges: ReadonlyMap<string, { displayName: string }>
}): React.JSX.Element {
  const repoName = notice.repoId
    ? (repoBadges.get(notice.repoId)?.displayName ?? notice.repoId)
    : null
  const copy = getBeadsListNoticeCopy(notice.kind === 'load-failed' ? 'error' : notice.kind)
  const retryButton = (
    <Button variant="outline" size="sm" onClick={onRetry}>
      {translate('auto.components.TaskPage.0bfbf62f75', 'Retry')}
    </Button>
  )
  if (notice.kind === 'load-failed') {
    return (
      <div
        role="alert"
        aria-atomic="true"
        className="flex items-center justify-between gap-3 border-b border-border/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <span>
          {translate('auto.components.TaskPage.0c0de0fc0e', "Couldn't load issues from")}{' '}
          <span className="font-mono">{repoName}</span> — {copy.body}
        </span>
        {retryButton}
      </div>
    )
  }
  return (
    // Why: mirrors GitHub's unresolved-source rows — a repo bd can't read must not render like genuine zero in a mixed selection.
    <div
      role="status"
      aria-atomic="true"
      className="flex items-center justify-between gap-3 border-b border-border/50 bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <span>
        <span className="font-mono">{repoName}</span> — {copy.title}. {copy.body}
      </span>
      {retryButton}
    </div>
  )
}

/** GitHub-style partial-failure banners for the beads table: a count banner plus per-repo rows with Retry. */
export function BeadsRepoNoticeRows({
  notices,
  onRetry,
  repoBadges,
  selectedRepoCount
}: BeadsRepoNoticeRowsProps): React.JSX.Element {
  const failedCount = notices.filter((notice) => notice.kind === 'load-failed').length
  return (
    <>
      {failedCount > 0 ? (
        // Why: same partial-failure count banner as the GitHub list, distinct from the per-repo rows below.
        <div className="border-b border-border/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200">
          {failedCount} {translate('auto.components.TaskPage.7762f4b03a', 'of')} {selectedRepoCount}{' '}
          {translate('auto.components.TaskPage.d1766fd62d', 'projects failed to load')}
        </div>
      ) : null}
      {notices.map((notice) => (
        <BeadsRepoNoticeRow
          key={`beads-repo-notice-${notice.repoId ?? 'unknown'}-${notice.kind}`}
          notice={notice}
          onRetry={onRetry}
          repoBadges={repoBadges}
        />
      ))}
    </>
  )
}
