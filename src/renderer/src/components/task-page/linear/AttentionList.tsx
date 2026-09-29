import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { AttentionIssueButton } from './AttentionIssueButton'
import { ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { LinearPersonalReadScope } from '../../../../../shared/linear/personal-read-types'
import { attentionNotificationLabel } from './attention-notification-label'
import { useLinearAttentionPage } from './use-linear-attention-page'

export function LinearAttentionList(props: {
  onOpenIssue: (issue: LinearIssue) => void
  mode: 'inbox' | 'triage'
  workspaceId: string
  teamId: string | null
  scope: LinearPersonalReadScope | null
  unavailable: string | null
}): React.JSX.Element {
  const { page, error, loading, load } = useLinearAttentionPage(props)
  const unavailable = props.unavailable ?? (page && 'unavailable' in page ? page.unavailable : null)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'linear.attention.readOnly',
            'Read-only. Manage notifications and triage decisions in Linear.'
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || Boolean(props.unavailable)}
          onClick={() => void load()}
        >
          {translate('linear.attention.refresh', 'Refresh')}
        </Button>
      </div>
      {unavailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          {unavailable}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {translate('linear.attention.loading', 'Loading from Linear…')}
        </p>
      ) : null}
      {!loading && !error && !unavailable && page?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('linear.attention.empty', 'No items in this list.')}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {translate(
          'linear.attention.executionUnavailable',
          'Execution association is not available in this view.'
        )}
      </p>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-border">
          {page?.items.map((item) => {
            const inbox = 'kind' in item
            const issue = inbox ? item.issue : item
            const safeUrl = item.url.startsWith('https://linear.app/') ? item.url : null
            return (
              <li key={item.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">
                    {inbox ? item.title : `${item.identifier} · ${item.title}`}
                  </p>
                  {inbox && item.subtitle ? (
                    <p className="break-words text-xs text-muted-foreground">{item.subtitle}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {inbox ? (
                      <>
                        <span>{attentionNotificationLabel(item.kind)}</span>
                        <Badge variant="outline">
                          {item.readAt
                            ? translate('linear.attention.read', 'Read')
                            : translate('linear.attention.unread', 'Unread')}
                        </Badge>
                        {item.snoozedUntilAt ? (
                          <span>
                            {translate('linear.attention.snoozed', 'Snoozed until {{date}}', {
                              date: new Date(item.snoozedUntilAt).toLocaleString()
                            })}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span>{item.state.name}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {issue ? (
                    <AttentionIssueButton
                      issue={issue}
                      workspaceId={props.workspaceId}
                      onOpenIssue={props.onOpenIssue}
                    />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!safeUrl}
                    onClick={() => {
                      if (safeUrl) {
                        void window.api.shell.openUrl(safeUrl)
                      }
                    }}
                  >
                    <ExternalLink />
                    {translate('linear.attention.open', 'Open in Linear')}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
        {page?.nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            disabled={loading || page.items.length >= 500}
            onClick={() => void load(page.nextCursor ?? undefined)}
          >
            {translate('linear.attention.more', 'Load more')}
          </Button>
        ) : null}
        {page && page.items.length >= 500 && page.nextCursor ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'linear.attention.limit',
              'Showing up to 500 items. Continue in Linear for older items.'
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
