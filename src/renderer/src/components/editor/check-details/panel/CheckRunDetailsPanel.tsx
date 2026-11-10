import React from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../../shared/github/check-types'
import { SourceControlFixSplitButton } from '@/components/right-sidebar/source-control/panel/source-control-fix-split-button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { useCheckRunDetailsFixWithAI } from '../actions/check-run-details-fix-with-ai'
import { formatCheckRunOutputForClipboard } from '../actions/check-run-clipboard-text'
import { CheckRunAnnotations } from './CheckRunAnnotations'
import { CheckRunJobs } from './CheckRunJobs'
import { CheckRunCopyButton } from './CheckRunCopyButton'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useCheckDetailsReadingPosition } from '../reading/use-check-details-reading-position'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

function formatCheckTimestamp(
  value: string | null | undefined,
  intlLocale: string = getIntlLocale()
): string | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return parsed.toLocaleString(intlLocale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

type CheckStatusLike = {
  gitlabAllowedFailure?: boolean
  status: PRCheckDetail['status'] | (string & {}) | null | undefined
  conclusion: PRCheckDetail['conclusion'] | (string & {}) | null | undefined
}

function getCheckStatusLabel(check: CheckStatusLike, t: Translate = translate): string {
  if (check.gitlabAllowedFailure === true && check.conclusion === 'neutral') {
    return t('checks.gitlabAllowedFailure', 'Allowed to fail')
  }
  const conclusion = check.conclusion ?? 'pending'
  switch (conclusion) {
    case 'success':
      return t('auto.components.editor.CheckRunDetailsPanel.8f2d0f5a91', 'Passed')
    case 'failure':
      return t('auto.components.editor.CheckRunDetailsPanel.4c8e1b2d73', 'Failed')
    case 'cancelled':
      return t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')
    case 'timed_out':
      return t('auto.components.editor.CheckRunDetailsPanel.2f6d8a1c45', 'Timed out')
    case 'action_required':
      return t('auto.components.editor.CheckRunDetailsPanel.actionRequired', 'Action required')
    case 'skipped':
      return t('auto.components.editor.CheckRunDetailsPanel.7b3e9d4f12', 'Skipped')
    case 'neutral':
      return t('auto.components.editor.CheckRunDetailsPanel.5a1c8e3d67', 'Neutral')
    case 'pending':
      return t('auto.components.editor.CheckRunDetailsPanel.3d9f2b8e14', 'Pending')
    default:
      return isFailureState(conclusion)
        ? t('auto.components.editor.CheckRunDetailsPanel.4c8e1b2d73', 'Failed')
        : t('auto.components.editor.CheckRunDetailsPanel.3d9f2b8e14', 'Pending')
  }
}

function isFailureState(state: string | null | undefined): boolean {
  return (
    state === 'failure' ||
    state === 'failed' ||
    state === 'action_required' ||
    state === 'cancelled' ||
    state === 'stale' ||
    state === 'startup_failure' ||
    state === 'timed_out'
  )
}

export function CheckRunDetailsPanel({
  check,
  details,
  loading,
  error,
  openUrl,
  worktreeId,
  onRefresh,
  tabId,
  viewStateScopeId,
  contextKey
}: {
  check: PRCheckDetail
  details: PRCheckRunDetails | null
  loading: boolean
  error: string | null
  openUrl: string | null | undefined
  worktreeId: string | null
  onRefresh?: () => void
  tabId?: string
  viewStateScopeId?: string
  contextKey?: string
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const {
    canFixWithAI,
    disabledReason,
    isFixing,
    fixPrompt,
    repoId,
    connectionId,
    launchPlatform,
    savedAgentId,
    savedCommandInputTemplate,
    savedAgentArgs,
    saveLaunchActionDefault,
    openSourceControlAiSettings,
    fixWithAI
  } = useCheckRunDetailsFixWithAI({
    worktreeId,
    check,
    details
  })
  const { ref: readingRef, owner: positionOwner } = useCheckDetailsReadingPosition(
    tabId,
    viewStateScopeId,
    contextKey
  )
  const [showProgress, setShowProgress] = React.useState(false)
  React.useEffect(() => {
    if (!loading) {
      return
    }
    const timer = window.setTimeout(() => setShowProgress(true), 200)
    return () => {
      window.clearTimeout(timer)
      setShowProgress(false)
    }
  }, [loading, tabId, viewStateScopeId, contextKey])
  const startedAt = formatCheckTimestamp(details?.startedAt, intlLocale)
  const completedAt = formatCheckTimestamp(details?.completedAt, intlLocale)
  const detailsStatusCheck: CheckStatusLike = {
    ...check,
    status: details?.status ?? check.status,
    conclusion: details?.conclusion ?? check.conclusion
  }
  const failedJobs =
    details?.jobs.filter((job) => {
      const state = job.conclusion ?? job.status
      return isFailureState(state)
    }) ?? []
  const jobs = details?.jobs ?? []
  const hasOutput = Boolean(details?.title || details?.summary || details?.text)
  const hasAnnotations = (details?.annotations.length ?? 0) > 0
  const hasJobs = jobs.length > 0
  const outputClipboardText = details ? formatCheckRunOutputForClipboard(details) : ''

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <h1 className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
            {check.name}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {canFixWithAI && (
              <SourceControlFixSplitButton
                label={t('auto.components.editor.CheckRunDetailsPanel.834cb3f23d', 'Fix with AI')}
                actionId="fixChecks"
                dialogTitle={t(
                  'auto.components.editor.CheckRunDetailsPanel.834cb3f23d',
                  'Fix with AI'
                )}
                dialogDescription={t(
                  'auto.components.editor.CheckRunDetailsPanel.c8f1a2d4e7',
                  'Choose the agent and edit the full command input before launch.'
                )}
                launchSource="task_page"
                contextUnavailableLabel={t(
                  'auto.components.editor.CheckRunDetailsPanel.b3e7f9a1c2',
                  'Check fix context unavailable'
                )}
                primaryTitle={t(
                  'auto.components.editor.CheckRunDetailsPanel.d5a8c2f1b9',
                  'Start the default AI agent to fix this check'
                )}
                primaryAriaLabel={t(
                  'auto.components.editor.CheckRunDetailsPanel.834cb3f23d',
                  'Fix with AI'
                )}
                chevronTitle={t(
                  'auto.components.editor.CheckRunDetailsPanel.e2b4d7c8a1',
                  'Choose an agent for this check'
                )}
                chevronAriaLabel={t(
                  'auto.components.editor.CheckRunDetailsPanel.f1c9e3a6d4',
                  'Choose agent to fix check'
                )}
                worktreeId={worktreeId}
                groupId={worktreeId}
                connectionId={connectionId}
                repoId={repoId}
                launchPlatform={launchPlatform}
                prompt={fixPrompt}
                isLaunching={loading || isFixing}
                disabledReason={disabledReason}
                variant="default"
                size="sm"
                iconClassName="size-3.5"
                primaryClassName="rounded-r-none font-medium"
                chevronClassName="rounded-l-none border-l border-primary-foreground/20 px-2"
                savedAgentId={savedAgentId}
                savedCommandInputTemplate={savedCommandInputTemplate}
                savedAgentArgs={savedAgentArgs}
                onSaveAgentDefault={saveLaunchActionDefault}
                onOpenSettings={openSourceControlAiSettings}
                onFixWithDefaultAgent={fixWithAI}
                onPromptDelivered={() =>
                  toast.success(
                    t(
                      'auto.components.editor.check.run.details.fix.with.ai.2ef90c9819',
                      'Started an AI agent for this check.'
                    )
                  )
                }
              />
            )}
            {onRefresh && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={loading}
                aria-busy={loading}
                onClick={onRefresh}
              >
                <span className="flex size-3.5 items-center justify-center">
                  {loading && showProgress ? (
                    <LoadingSpinner className="size-3.5" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                </span>
                {t('auto.components.editor.CheckRunDetailsPanel.b7f5e2c91a', 'Refresh')}
              </Button>
            )}
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t('auto.components.editor.CheckRunDetailsPanel.a54ae21c6f', 'Status:')}{' '}
            {details ? getCheckStatusLabel(detailsStatusCheck, t) : getCheckStatusLabel(check, t)}
          </span>
          {startedAt && (
            <span>
              {t('auto.components.editor.CheckRunDetailsPanel.fd46a70f1a', 'Started')} {startedAt}
            </span>
          )}
          {completedAt && (
            <span>
              {t('auto.components.editor.CheckRunDetailsPanel.00e1c1658a', 'Completed')}{' '}
              {completedAt}
            </span>
          )}
          {check.checkRunId && (
            <span className="font-mono">
              {t('auto.components.editor.CheckRunDetailsPanel.aa8494ae3c', 'check #')}
              {check.checkRunId}
            </span>
          )}
          {check.workflowRunId && (
            <span className="font-mono">
              {t('auto.components.editor.CheckRunDetailsPanel.2dd5ddabc4', 'workflow #')}
              {check.workflowRunId}
            </span>
          )}
        </div>
      </div>

      <div className="h-12 shrink-0 overflow-y-auto px-5 py-2 scrollbar-sleek">
        {error ? (
          <div role="alert" className="break-words text-xs text-destructive">
            {error}
          </div>
        ) : loading && showProgress ? (
          <div
            role="status"
            aria-live="polite"
            className="break-words text-xs text-muted-foreground"
          >
            {t('githubChecks.refreshingDetails', 'Refreshing check details…')}
          </div>
        ) : null}
      </div>
      <div
        ref={readingRef}
        aria-busy={loading}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-sleek"
      >
        {loading && !details ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
          >
            <LoadingSpinner className="size-4" />
            {t('auto.components.editor.CheckRunDetailsPanel.1f2b980522', 'Loading check details…')}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {(isFailureState(detailsStatusCheck.conclusion)
              ? ['jobs', 'output', 'annotations']
              : ['output', 'annotations', 'jobs']
            ).map((section) => {
              if (section === 'jobs') {
                return hasJobs ? (
                  <CheckRunJobs
                    key="jobs"
                    check={check}
                    jobs={jobs}
                    hasFailedJobs={failedJobs.length > 0}
                    positionOwner={positionOwner}
                  />
                ) : null
              }
              if (section === 'annotations') {
                return hasAnnotations ? (
                  <CheckRunAnnotations
                    key="annotations"
                    annotations={details!.annotations}
                    worktreeId={worktreeId}
                  />
                ) : null
              }
              return hasOutput ? (
                <section key="output" className="rounded-md border border-border bg-background">
                  <div className="flex items-center justify-between border-b border-border px-3 py-2">
                    <div className="text-sm font-medium">
                      {t('auto.components.editor.CheckRunDetailsPanel.d098e5529a', 'Output')}
                    </div>
                    <CheckRunCopyButton
                      text={outputClipboardText}
                      label={t(
                        'auto.components.editor.CheckRunDetailsPanel.copyOutput',
                        'Copy output'
                      )}
                    />
                  </div>
                  <div className="px-3 py-3">
                    {details?.title && (
                      <div className="mb-2 text-sm font-medium text-foreground">
                        {details.title}
                      </div>
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
              ) : null
            })}

            {!error && !hasOutput && !hasAnnotations && !hasJobs && (
              <div className="text-sm text-muted-foreground">
                {t(
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
            onClick={(event) => openAppHttpLink(openUrl, { worktreeId, event })}
          >
            {t('auto.components.editor.CheckRunDetailsPanel.a916648574', 'Open details')}
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
