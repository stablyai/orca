import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { cn } from '@/lib/class-names'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import {
  PullRequestIcon,
  prStateColor
} from '@/components/right-sidebar/checks-panel/presentation/check-presentation'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { ngitShortId, type NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { NgitConversation } from './ngit-conversation'
import { NgitItemActions } from './ngit-item-actions'
import { useNgitItemDetails } from './use-ngit-item-details'

/** The checked-out branch's ngit pull request, laid out like the panel's GitHub one. */
export function NgitBranchReview({
  repo,
  review
}: {
  repo: Repo
  review: HostedReviewInfo
}): React.JSX.Element {
  const [item, setItem] = useState<NgitWorkItem | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  useEffect(() => {
    let stale = false
    ngitApiFor(repo)
      .listWorkItems(false)
      .then((list) => {
        if (!stale) {
          setItem(
            list.items.find((entry) => entry.type === 'pr' && entry.number === review.number) ??
              null
          )
        }
      })
      .catch((error) => console.warn('Could not read the ngit pull request:', error))
    return () => {
      stale = true
    }
  }, [repo, review.number, review.updatedAt, refreshNonce])

  const reload = useCallback(() => setRefreshNonce((nonce) => nonce + 1), [])

  return item ? (
    <NgitBranchReviewContent key={item.eventId} repo={repo} item={item} onChanged={reload} />
  ) : (
    <div className="flex flex-1 items-center justify-center p-6">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function NgitBranchReviewContent({
  repo,
  item,
  onChanged
}: {
  repo: Repo
  item: NgitWorkItem
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useNgitItemDetails(item, repo, onChanged)
  const shown = state.details?.item ?? item
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
      <div className="space-y-2.5 border-b border-border px-3 py-3">
        <div className="flex items-center gap-2">
          <PullRequestIcon className="size-4 shrink-0 text-muted-foreground" />
          <button
            type="button"
            className="rounded px-0.5 text-[12px] font-semibold text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title={t('components.taskPage.ngit.openInBrowser', 'Open on gitworkshop.dev')}
            onClick={(event) => openAppHttpLink(shown.url, { event })}
          >
            {ngitShortId(shown.eventId)}
          </button>
          <span
            className={cn(
              'rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
              prStateColor(shown.state)
            )}
          >
            {shown.state}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('components.taskPage.ngit.refresh', 'Refresh')}
            disabled={state.loading}
            onClick={state.refresh}
          >
            <RefreshCw className={cn('size-3.5', state.loading && 'animate-spin')} />
          </Button>
        </div>
        <p className="text-[12px] leading-snug text-foreground">{shown.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[shown.author, shown.branchName].filter(Boolean).join(' · ')}
        </p>
        <NgitItemActions item={item} state={state} />
      </div>
      <div className="space-y-3 px-3 py-3 text-sm">
        <NgitConversation details={state.details} error={state.error} loading={state.loading} />
      </div>
    </div>
  )
}
