import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { PRCheckJob } from '../../../../shared/github/check-types'
import type { CheckDetailsReadingOwner } from '@/components/editor/check-details-reading-owner'
import { resolveStepOutcome } from '@/components/editor/check-job-step-status'
import { useCheckLogReadingPosition } from './use-check-log-reading-position'

const LOG_EXCERPT_ERROR_LINE_PATTERN =
  /(?:##\[error\]|::error::|::error\b|\berror:|FAILED|exit code|ENOENT|EACCES|panic:|AssertionError)/i

function getLogExcerptScrollTop(pre: HTMLPreElement, logTail: string): number {
  const lines = logTail.split(/\r?\n/)
  let targetLineIndex = lines.length - 1
  for (let index = 0; index < lines.length; index += 1) {
    if (LOG_EXCERPT_ERROR_LINE_PATTERN.test(lines[index] ?? '')) {
      targetLineIndex = index
    }
  }

  const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight)
  const approximateLineHeight = Number.isFinite(lineHeight) ? lineHeight : 16
  const targetScroll = targetLineIndex * approximateLineHeight
  const maxScroll = Math.max(0, pre.scrollHeight - pre.clientHeight)
  if (targetLineIndex < lines.length - 1) {
    return Math.min(maxScroll, Math.max(0, targetScroll - pre.clientHeight / 3))
  }
  return maxScroll
}

function CopyButton({
  text,
  title = 'Copy comment'
}: {
  text: string
  title?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may settle after unmount; do not start a reset timer then.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void window.api.ui.writeClipboardText(text).then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
    },
    [clearCopiedResetTimer, text]
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          ref={setCopyButtonRef}
          aria-label={
            copied ? translate('auto.components.editor.CheckRunCopyButton.copied', 'Copied') : title
          }
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {copied ? translate('auto.components.editor.CheckRunCopyButton.copied', 'Copied') : title}
      </TooltipContent>
    </Tooltip>
  )
}

export function CheckJobLogTail({
  job,
  surface,
  jobIdentity = '',
  expanded = false,
  positionOwner
}: {
  job: Pick<PRCheckJob, 'logTail' | 'logState' | 'status' | 'conclusion'>
  surface: 'sidebar' | 'details'
  jobIdentity?: string
  expanded?: boolean
  positionOwner?: CheckDetailsReadingOwner
}): React.JSX.Element | null {
  const logTail = job.logTail ?? ''
  const logPreRef = useCheckLogReadingPosition(
    job.logTail,
    expanded,
    jobIdentity,
    positionOwner,
    job.logState
  )
  useEffect(() => {
    if (!expanded && logPreRef.current && logTail) {
      logPreRef.current.scrollTop = getLogExcerptScrollTop(logPreRef.current, logTail)
    }
  }, [expanded, logPreRef, logTail])
  const running =
    job.status === 'queued' ||
    job.status === 'in_progress' ||
    job.status === 'running' ||
    job.status === 'pending'
  if (!logTail && !job.logState && !running && resolveStepOutcome(job) !== 'failure') {
    return null
  }

  return (
    <div className="mt-3 min-w-0">
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 text-3xs font-semibold uppercase tracking-wide text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.d713f500b2',
            'Log excerpt'
          )}
        </div>
        {logTail && (
          <CopyButton
            text={logTail}
            title={translate(
              'auto.components.right.sidebar.checks.panel.content.679bf2093c',
              'Copy log excerpt'
            )}
          />
        )}
      </div>
      {job.logState === 'error' && (
        <p className="mb-1.5 text-xs text-destructive">
          {surface === 'details'
            ? translate(
                'githubChecks.logsLoadErrorDetails',
                "Couldn't load logs. Use Refresh to retry."
              )
            : translate(
                'githubChecks.logsLoadErrorSidebar',
                "Couldn't load logs. Open View full details, then use Refresh to retry."
              )}
        </p>
      )}
      {logTail ? (
        <pre
          ref={logPreRef}
          className={cn(
            'overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-xs scrollbar-sleek',
            expanded
              ? 'min-h-48 max-h-[min(50vh,32rem)] break-all text-foreground'
              : 'max-h-72 text-muted-foreground'
          )}
        >
          {logTail}
        </pre>
      ) : job.logState !== 'error' ? (
        <p className="text-xs text-muted-foreground">
          {job.logState === 'empty'
            ? translate('githubChecks.logsEmpty', 'No log output was returned.')
            : running && job.logState !== 'available'
              ? translate('githubChecks.logsNotYetAvailable', 'Log output is not available yet.')
              : job.logState === 'not_requested'
                ? translate(
                    'githubChecks.logsNotRequested',
                    "Log excerpt wasn't requested. At most five failed-job excerpts are loaded per check."
                  )
                : translate('githubChecks.noLogExcerpt', 'No log excerpt is available.')}
        </p>
      ) : null}
    </div>
  )
}
