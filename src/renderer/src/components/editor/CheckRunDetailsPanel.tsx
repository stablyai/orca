import React from 'react'
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../shared/types'
import { CheckJobLogTail } from '@/components/right-sidebar/check-job-log-tail'
import { translate } from '@/i18n/i18n'

function formatCheckTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = check.conclusion ?? 'pending'
  switch (conclusion) {
    case 'success':
      return translate('auto.components.editor.CheckRunDetailsPanel.8f2d0f5a91', 'Passed')
    case 'failure':
      return translate('auto.components.editor.CheckRunDetailsPanel.4c8e1b2d73', 'Failed')
    case 'cancelled':
      return translate('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'timed_out':
      return translate('auto.components.editor.CheckRunDetailsPanel.2f6d8a1c45', 'Timed out')
    case 'skipped':
      return translate('auto.components.editor.CheckRunDetailsPanel.7b3e9d4f12', 'Skipped')
    case 'neutral':
      return translate('auto.components.editor.CheckRunDetailsPanel.5a1c8e3d67', 'Neutral')
    case 'pending':
      return translate('auto.components.editor.CheckRunDetailsPanel.3d9f2b8e14', 'Pending')
    default:
      return conclusion
  }
}

function isFailureState(state: string | null | undefined): boolean {
  return state === 'failure' || state === 'cancelled' || state === 'timed_out'
}

export function CheckRunDetailsPanel({
  check,
  details,
  loading,
  error,
  openUrl,
  onRefresh
}: {
  check: PRCheckDetail
  details: PRCheckRunDetails | null
  loading: boolean
  error: string | null
  openUrl: string | null | undefined
  onRefresh?: () => void
}): React.JSX.Element {
  const startedAt = formatCheckTimestamp(details?.startedAt)
  const completedAt = formatCheckTimestamp(details?.completedAt)
  const detailsStatusCheck: PRCheckDetail = {
    ...check,
    status: (details?.status as PRCheckDetail['status'] | undefined) ?? check.status,
    conclusion: (details?.conclusion as PRCheckDetail['conclusion'] | undefined) ?? check.conclusion
  }
  const failedJobs =
    details?.jobs.filter((job) => {
      const state = job.conclusion ?? job.status
      return isFailureState(state)
    }) ?? []
  const jobs = failedJobs.length > 0 ? failedJobs : (details?.jobs ?? [])
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = jobs.length > 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <h1 className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
            {check.name}
          </h1>
          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw className={`size-3.5${loading ? ' animate-spin' : ''}`} />
              {translate('auto.components.editor.CheckRunDetailsPanel.b7f5e2c91a', 'Refresh')}
            </Button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {translate('auto.components.editor.CheckRunDetailsPanel.a54ae21c6f', 'Status:')}{' '}
            {details ? getCheckStatusLabel(detailsStatusCheck) : getCheckStatusLabel(check)}
          </span>
          {startedAt && (
            <span>
              {translate('auto.components.editor.CheckRunDetailsPanel.fd46a70f1a', 'Started')}{' '}
              {startedAt}
            </span>
          )}
          {completedAt && (
            <span>
              {translate('auto.components.editor.CheckRunDetailsPanel.00e1c1658a', 'Completed')}{' '}
              {completedAt}
            </span>
          )}
          {check.checkRunId && (
            <span className="font-mono">
              {translate('auto.components.editor.CheckRunDetailsPanel.aa8494ae3c', 'check #')}
              {check.checkRunId}
            </span>
          )}
          {check.workflowRunId && (
            <span className="font-mono">
              {translate('auto.components.editor.CheckRunDetailsPanel.2dd5ddabc4', 'workflow #')}
              {check.workflowRunId}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {translate(
              'auto.components.editor.CheckRunDetailsPanel.1f2b980522',
              'Loading check details…'
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            {error && <div className="text-sm text-muted-foreground">{error}</div>}

            {hasOutput && (
              <section className="rounded-md border border-border bg-background">
                <div className="border-b border-border px-3 py-2 text-sm font-medium">
                  {translate('auto.components.editor.CheckRunDetailsPanel.d098e5529a', 'Output')}
                </div>
                <div className="px-3 py-3">
                  {details?.title && (
                    <div className="mb-2 text-sm font-medium text-foreground">{details.title}</div>
                  )}
                  {details?.summary && (
                    <CommentMarkdown
                      content={details.summary}
                      variant="document"
                      className="min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                    />
                  )}
                  {details?.text && (
                    <CommentMarkdown
                      content={details.text}
                      variant="document"
                      className="mt-3 min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
                    />
                  )}
                </div>
              </section>
            )}

            {hasAnnotations && (
              <section className="rounded-md border border-border bg-background">
                <div className="border-b border-border px-3 py-2 text-sm font-medium">
                  {translate(
                    'auto.components.editor.CheckRunDetailsPanel.f2fe8a4e8f',
                    'Annotations'
                  )}
                </div>
                <div className="divide-y divide-border/50">
                  {details!.annotations.map((annotation, index) => (
                    <div key={`${annotation.path ?? 'annotation'}-${index}`} className="px-3 py-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                          {annotation.path ??
                            translate(
                              'auto.components.editor.CheckRunDetailsPanel.cdbfda4dec',
                              'Annotation'
                            )}
                          {annotation.startLine ? `:${annotation.startLine}` : ''}
                        </span>
                        {annotation.annotationLevel && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {annotation.annotationLevel}
                          </span>
                        )}
                      </div>
                      {annotation.title && (
                        <div className="mt-2 text-sm font-medium text-foreground">
                          {annotation.title}
                        </div>
                      )}
                      <div className="mt-2 break-words text-sm text-foreground">
                        {annotation.message}
                      </div>
                      {annotation.rawDetails && (
                        <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs text-muted-foreground scrollbar-sleek">
                          {annotation.rawDetails}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {hasJobs && (
              <section className="rounded-md border border-border bg-background">
                <div className="border-b border-border px-3 py-2 text-sm font-medium">
                  {failedJobs.length > 0
                    ? translate(
                        'auto.components.editor.CheckRunDetailsPanel.066fedd446',
                        'Failed jobs'
                      )
                    : translate('auto.components.editor.CheckRunDetailsPanel.49731703ea', 'Jobs')}
                </div>
                <div className="divide-y divide-border/50">
                  {jobs.map((job, index) => (
                    <div key={`${job.name}-${index}`} className="px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {job.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {job.conclusion ??
                            job.status ??
                            translate(
                              'auto.components.editor.CheckRunDetailsPanel.ee07b33924',
                              'unknown'
                            )}
                        </span>
                      </div>
                      {job.steps.length > 0 && (
                        <div className="mt-2 grid gap-1">
                          {job.steps.map((step) => (
                            <div
                              key={step.name}
                              className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                            >
                              <span className="min-w-0 flex-1 truncate">{step.name}</span>
                              <span className="shrink-0">{step.conclusion ?? step.status}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {job.logTail && <CheckJobLogTail logTail={job.logTail} />}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!error && !hasOutput && !hasAnnotations && !hasJobs && (
              <div className="text-sm text-muted-foreground">
                {translate(
                  'auto.components.editor.CheckRunDetailsPanel.07eccfa397',
                  'No details are available for this check.'
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {openUrl && (
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.api.shell.openUrl(openUrl)}
          >
            {translate('auto.components.editor.CheckRunDetailsPanel.a916648574', 'Open details')}
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
