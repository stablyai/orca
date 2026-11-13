import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/hooks/use-now'
import { useAppStore } from '@/store'
import { isMacPlatform } from '../../../terminal-pane/links/terminal-link-open-hints'
import { openChecksPanelHostedReviewUrl } from '../review-actions/checks-panel-hosted-review-click-routing'
import type { ChecksPanelRefreshInput } from '../checks-panel-review-state-model'
import type { ChecksPanelManualRefreshResult } from '../refresh/checks-panel-manual-refresh-result'
import {
  getPositiveReviewPresentation,
  type PositiveReviewPresentation
} from './checks-panel-positive-review-status'
import { requestReviewHeaderFocusAfterRetry } from './positive-review-focus-handoff'
import type { PRDetailRecoveryStatus } from '@/store/github/pull-requests/pr-detail-recovery-context'

// Matches the ticket settlement budget: a Retry that outlasts it reports that GitHub didn't respond.
const RETRY_BUDGET_MS = 30_000

// Defer visible loading so fast local reads stay quiet while SSH still gets feedback.
const SPINNER_DELAY_MS = 200

function useDelayedFlag(on: boolean): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), SPINNER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [on])
  return on && shown
}

export function ChecksPanelPositiveReviewStatus({
  presentation,
  announcement,
  actionsDisabled,
  onOpen,
  onRetry
}: {
  presentation: PositiveReviewPresentation
  /** Changes once per terminal outcome so the same text is announced again. */
  announcement: number
  actionsDisabled: boolean
  onOpen: (event: React.MouseEvent<HTMLButtonElement>, url: string) => void
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const showSpinner = useDelayedFlag(presentation.spinner)
  const spokenKey = `${presentation.statusKind}:${announcement}`
  const [spoken, setSpoken] = useState({ key: spokenKey, text: presentation.statusText })
  if (spoken.key !== spokenKey) {
    setSpoken({ key: spokenKey, text: presentation.statusText })
  }
  const retryBlocked = presentation.retryBlocked || actionsDisabled
  return (
    <>
      <div className="text-sm font-medium text-foreground">{presentation.title}</div>
      <div
        role="status"
        aria-live="polite"
        className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        {showSpinner ? <LoadingSpinner className="size-3 shrink-0" /> : null}
        {/* Visible text may tick (gate times); assistive tech hears each state once. */}
        <span aria-hidden="true">{presentation.statusText}</span>
        <span key={announcement} className="sr-only">
          {spoken.text}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {presentation.open ? (
          <Button
            size="xs"
            variant="outline"
            aria-label={presentation.open.ariaLabel}
            onClick={(event) => {
              if (presentation.open) {
                onOpen(event, presentation.open.url)
              }
            }}
          >
            {presentation.open.label}
          </Button>
        ) : null}
        {/* Dim through a wrapper: Button owns its own effects. */}
        <span className={retryBlocked ? 'inline-flex cursor-default opacity-50' : 'inline-flex'}>
          <Button
            size="xs"
            variant="outline"
            // aria-disabled keeps keyboard focus on Retry while a read or rate gate blocks it.
            aria-disabled={retryBlocked || undefined}
            onClick={() => {
              if (!retryBlocked) {
                onRetry()
              }
            }}
          >
            {t('auto.components.right.sidebar.ChecksPanel.review.retry', 'Retry')}
          </Button>
        </span>
      </div>
    </>
  )
}

/** Positive and existing-review states: wires the state table to recovery, refresh state and actions. */
export function ChecksPanelPositiveReview({
  detachedHeadDisplay,
  reviewShortLabel,
  providerName,
  reviewNumber,
  openReviewUrl,
  refresh,
  manualRetryInFlight,
  actionsDisabled,
  worktreeId,
  recoveryContextKey,
  manualRefreshFailed,
  onRetry,
  setRetrying,
  retryBudgetMs = RETRY_BUDGET_MS
}: {
  detachedHeadDisplay: React.ComponentProps<typeof DetachedHeadBadge>['display'] | null
  reviewShortLabel: string
  providerName: string
  reviewNumber: number | null
  openReviewUrl: string | null
  refresh: ChecksPanelRefreshInput | undefined
  manualRetryInFlight: boolean
  actionsDisabled: boolean
  worktreeId: string | null
  /** This render's recovery context; store state for another context is ignored. */
  recoveryContextKey: string | null
  manualRefreshFailed: boolean
  onRetry: () => Promise<ChecksPanelManualRefreshResult>
  setRetrying: (retrying: boolean) => void
  retryBudgetMs?: number
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const storedRecovery = useAppStore((s) => s.prDetailRecovery)
  const recovery =
    storedRecovery && storedRecovery.contextKey === recoveryContextKey ? storedRecovery : null
  const cancelRecovery = useAppStore((s) => s.cancelGitHubPRDetailRecovery)
  const settleRetry = useAppStore((s) => s.settleGitHubPRDetailRetry)
  const blockRef = useRef<HTMLDivElement>(null)
  const pendingRetry = useRef(false)
  const retryTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  // A Retry budget belongs to its context: drop it on a context change or unmount.
  useEffect(() => {
    const timers = retryTimers.current
    return () => {
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
      pendingRetry.current = false
    }
  }, [recoveryContextKey])
  // Automatic success unmounts this block; keep focus that was inside it by handing it to the header.
  useLayoutEffect(() => {
    const block = blockRef.current
    return () => {
      if (block?.contains(document.activeElement)) {
        requestReviewHeaderFocusAfterRetry(worktreeId)
      }
    }
  }, [worktreeId])
  const now = useNow(
    1000,
    recovery?.status.kind === 'paused' ||
      refresh?.retryDisabledUntil !== undefined ||
      refresh?.nextAutoRetryAt !== undefined
  )
  const presentation = getPositiveReviewPresentation(
    {
      reviewShortLabel,
      providerName,
      reviewNumber,
      openReviewUrl,
      recovery: recovery?.status ?? null,
      manualRetryInFlight,
      refresh: refresh ?? (manualRefreshFailed ? { status: 'error' } : undefined),
      now,
      formatTime: (at) =>
        new Date(at).toLocaleTimeString(intlLocale, { hour: 'numeric', minute: '2-digit' })
    },
    t
  )
  return (
    <div ref={blockRef} className="px-4 py-6">
      {detachedHeadDisplay && (
        <div className="mb-3">
          <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />
        </div>
      )}
      <ChecksPanelPositiveReviewStatus
        presentation={presentation}
        announcement={recovery?.terminalCount ?? 0}
        actionsDisabled={actionsDisabled}
        onOpen={(event, url) =>
          openChecksPanelHostedReviewUrl({ url, event, isMac: isMacPlatform(), worktreeId })
        }
        onRetry={() => {
          // A click while this panel's earlier Retry still reads would be latched out: it does nothing.
          if (!worktreeId || pendingRetry.current) {
            return
          }
          const previous = recovery?.status
          cancelRecovery()
          setRetrying(true)
          pendingRetry.current = true
          const contextKey = recoveryContextKey
          let settled = false
          // Still mounted when this click's own read ends means no details appeared.
          const report = (status: PRDetailRecoveryStatus): void => {
            setRetrying(false)
            if (contextKey && blockRef.current) {
              settleRetry(contextKey, status)
            }
          }
          const budget = setTimeout(() => {
            if (!settled) {
              report({ kind: 'timeout' })
            }
          }, retryBudgetMs)
          retryTimers.current.add(budget)
          void onRetry().then((result) => {
            settled = true
            pendingRetry.current = false
            clearTimeout(budget)
            retryTimers.current.delete(budget)
            // A click that read nothing restores what was shown, unannounced; a late real result replaces a timeout.
            if (result.kind === 'skipped') {
              setRetrying(false)
              if (contextKey && previous && blockRef.current) {
                settleRetry(contextKey, previous, false)
              }
              return
            }
            report(
              result.kind === 'failed'
                ? { kind: 'failed', errorType: result.errorType }
                : { kind: 'unusable' }
            )
          })
        }}
      />
    </div>
  )
}
