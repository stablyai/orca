import React from 'react'
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { CheckDetailsLoadState } from '@/components/github-checks-tab-state'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import { translate } from '@/i18n/i18n'
import { getCheckConclusion } from '@/components/pr-check-counts'
import {
  formatCheckTimestamp,
  getKeyedCheckAnnotations,
  getKeyedCheckJobs,
  getCheckDetailsKey,
  getCheckStatusLabel
} from '@/components/github/pr-check-presentation'

export function ChecksTabCheckDetails({
  check,
  state,
  onRetry
}: {
  check: PRCheckDetail
  state: CheckDetailsLoadState | undefined
  onRetry: (check: PRCheckDetail, key: string) => void
}): React.JSX.Element {
  const details = state?.details
  const openUrl = details?.detailsUrl ?? details?.url ?? check.url
  const startedAt = formatCheckTimestamp(details?.startedAt)
  const completedAt = formatCheckTimestamp(details?.completedAt)
  const detailsStatusCheck: PRCheckDetail = {
    ...check,
    status: (details?.status as PRCheckDetail['status'] | undefined) ?? check.status,
    conclusion: (details?.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
  }
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = (details?.jobs.length ?? 0) > 0

  return (
    <div className="mx-2 mb-2 mt-1 min-w-0 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
      {state?.loading && !state.error ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {translate('auto.components.GitHubItemDialog.934d87ab96', 'Loading check details…')}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {translate('auto.components.GitHubItemDialog.9c3ba11a05', 'Status:')}{' '}
              {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
            </span>
            {startedAt && (
              <span>
                {translate('auto.components.GitHubItemDialog.4812814bc8', 'Started')} {startedAt}
              </span>
            )}
            {completedAt && (
              <span>
                {translate('auto.components.GitHubItemDialog.0f478f5efa', 'Completed')}{' '}
                {completedAt}
              </span>
            )}
            {check.checkRunId && (
              <span className="font-mono">
                {translate('auto.components.GitHubItemDialog.485609c4f2', 'check #')}
                {check.checkRunId}
              </span>
            )}
          </div>

          {state?.error && (
            <div role="alert" className="flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 flex-1 break-words text-[12px] text-destructive">
                {state.error}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={state.loading}
                aria-busy={state.loading}
                onClick={() => onRetry(check, getCheckDetailsKey(check))}
              >
                <RefreshCw className={cn('size-3', state.loading && 'animate-spin')} />
                {state.loading
                  ? translate('githubChecks.retrying', 'Retrying…')
                  : translate('auto.components.GitHubItemDialog.dcb3c546fe', 'Retry')}
              </Button>
            </div>
          )}

          {hasOutput && (
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70 px-2.5 py-2">
              {details?.title && (
                <div className="mb-1 text-[12px] font-medium text-foreground">{details.title}</div>
              )}
              {details?.summary && (
                <CommentMarkdown
                  content={details.summary}
                  variant="document"
                  className="min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                />
              )}
              {details?.text && (
                <CommentMarkdown
                  content={details.text}
                  variant="document"
                  className="mt-2 min-w-0 max-w-full overflow-hidden break-words text-[12px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                />
              )}
            </div>
          )}

          {hasAnnotations && (
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
              <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                {translate('auto.components.GitHubItemDialog.96d8f36798', 'Annotations')}
              </div>
              <div className="flex flex-col">
                {getKeyedCheckAnnotations(details!.annotations).map(
                  ({ key, item: annotation }, index) => (
                    <div
                      key={key}
                      className={cn(
                        'min-w-0 px-2.5 py-2 text-[12px]',
                        index > 0 && 'border-t border-border/30'
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {annotation.path ??
                            translate('auto.components.GitHubItemDialog.7d42606f66', 'Annotation')}
                          {annotation.startLine ? `:${annotation.startLine}` : ''}
                        </span>
                        {annotation.annotationLevel && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {annotation.annotationLevel}
                          </span>
                        )}
                      </div>
                      {annotation.title && (
                        <div className="mt-1 text-[12px] font-medium text-foreground">
                          {annotation.title}
                        </div>
                      )}
                      <div className="mt-1 break-words text-[12px] text-foreground">
                        {annotation.message}
                      </div>
                      {annotation.rawDetails && (
                        <pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                          {annotation.rawDetails}
                        </pre>
                      )}
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {hasJobs && (
            <div className="min-w-0 rounded-md border border-border/40 bg-background/70">
              <div className="border-b border-border/40 px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                {translate('auto.components.GitHubItemDialog.08d072664d', 'Jobs')}
              </div>
              <div className="flex flex-col">
                {getKeyedCheckJobs(details!.jobs).map(({ key, item: job }, index) => (
                  <div
                    key={key}
                    className={cn('min-w-0 px-2.5 py-2', index > 0 && 'border-t border-border/30')}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                        {job.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {job.conclusion ??
                          job.status ??
                          translate('auto.components.GitHubItemDialog.773ff70035', 'unknown')}
                      </span>
                    </div>
                    {job.steps.length > 0 && (
                      <div className="mt-1 grid gap-1">
                        {job.steps.map((step) => (
                          <div
                            key={step.name}
                            className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground"
                          >
                            <span className="min-w-0 flex-1 truncate">{step.name}</span>
                            <span className="shrink-0">{step.conclusion ?? step.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!state?.error && !hasOutput && !hasAnnotations && !hasJobs && (
            <div className="text-[12px] text-muted-foreground">
              {getCheckConclusion(check) === 'action_required'
                ? translate(
                    'auto.components.GitHubItemDialog.checkActionRequiredHint',
                    'Needs a manual action on GitHub (e.g. approving the run) to unblock merging.'
                  )
                : translate(
                    'auto.components.GitHubItemDialog.744197c84d',
                    'No inline output is available for this check.'
                  )}
            </div>
          )}

          {openUrl && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => window.api.shell.openUrl(openUrl)}
              >
                {translate(
                  'auto.components.GitHubItemDialog.checkOpenInBrowser',
                  'Open in browser'
                )}
                <ExternalLink className="size-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
