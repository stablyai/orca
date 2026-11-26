import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { NgitItemSheet } from './ngit-item-sheet'
import { NgitStateIcon, ngitStateLabel, ngitTypeLabel } from './ngit-work-item-state'

/** The checked-out branch's ngit pull request, with its comments and status one click away. */
export function NgitBranchReview({
  repo,
  review
}: {
  repo: Repo
  review: HostedReviewInfo
}): React.JSX.Element {
  const t = useTranslate()
  const [item, setItem] = useState<NgitWorkItem | null>(null)
  const [open, setOpen] = useState(false)
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
      // The review summary above stays; only the details button waits.
      .catch((error) => console.warn('Could not read the ngit pull request:', error))
    return () => {
      stale = true
    }
  }, [repo, review.number, review.updatedAt, refreshNonce])

  const shown = item ?? { type: 'pr' as const, state: review.state }
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 scrollbar-sleek">
      <div className="flex items-start gap-2">
        <NgitStateIcon item={shown} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{review.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {ngitTypeLabel(shown)} · {ngitStateLabel(shown)}
            {item ? ` · ${item.author}` : null}
          </p>
          {item ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('components.taskPage.ngit.commentCount', 'Comments: {{total}}', {
                total: item.commentCount
              })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!item} onClick={() => setOpen(true)}>
          {item ? null : <LoaderCircle className="size-3.5 animate-spin" />}
          {t('components.taskPage.ngit.viewDetails', 'View details')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => openAppHttpLink(review.url, { event })}
        >
          <ExternalLink className="size-3.5" />
          {t('components.taskPage.ngit.openInBrowser', 'Open on gitworkshop.dev')}
        </Button>
      </div>
      {open && item ? (
        <NgitItemSheet
          item={item}
          repo={repo}
          onClose={() => setOpen(false)}
          onChanged={() => setRefreshNonce((nonce) => nonce + 1)}
        />
      ) : null}
    </div>
  )
}
