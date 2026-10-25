import { SecuritySurface } from '@/components/ui/security-surface'
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type {
  BrowserCertificateFailure,
  BrowserCertificateProceedFailureReason,
  BrowserCertificateProceedResult,
  BrowserLoadError
} from '../../../../../shared/browser-workspace-types'
import { normalizeCertificateError } from '../../../../../shared/browser-certificate-errors'
import {
  describeBrowserLoadFailure,
  type BrowserLoadFailureRoute
} from '../../../../../shared/browser-load-failure'
import {
  formatLoadFailureDescription,
  formatLoadFailureTitle,
  isCertificateLoadError
} from './browser-notices'
import {
  BrowserLoadFailureAutoRetryStatus,
  type BrowserLoadFailureAutoRetry,
  type BrowserLoadFailureRetry
} from './browser-load-failure-auto-retry'

type BrowserLoadFailureOverlayProps = {
  loadError: BrowserLoadError
  externalUrl?: string | null
  onRetry: BrowserLoadFailureRetry
  onOpenExternal?: (url: string) => void
  certificateFailure?: BrowserCertificateFailure | null
  expectedBrowserPageId?: string | null
  onProceedCertificate?: (challengeId: string) => Promise<BrowserCertificateProceedResult>
  /** Set for SSH-routed pages: connection failures usually mean the SSH host cannot reach the site. */
  sshRoutedHint?: boolean
  /** Set when the page's SSH host carries a persisted "Try anyway": undoes it so the connection check runs again. */
  onRecheckSshRoute?: (() => void) | null
  /** How the page reaches the network; omit when this pane can't tell. */
  route?: BrowserLoadFailureRoute | null
  /** Set by panes whose Retry goes out the page's own route, so the page can recover by itself. */
  autoRetry?: BrowserLoadFailureAutoRetry
}

type CertificateProceedAttempt = {
  challengeId: string
  state: 'submitting' | 'failed'
  showConnecting: boolean
  reason?: BrowserCertificateProceedFailureReason | 'request-failed'
}

function getMatchingCertificateFailure(args: {
  loadError: BrowserLoadError
  certificateFailure?: BrowserCertificateFailure | null
  expectedBrowserPageId?: string | null
  canProceed: boolean
}): BrowserCertificateFailure | null {
  const { loadError, certificateFailure, expectedBrowserPageId, canProceed } = args
  const errorMatchesChallenge = Boolean(
    certificateFailure &&
    (loadError.code === -1 ||
      (loadError.code === certificateFailure.errorCode &&
        normalizeCertificateError(certificateFailure.error) ===
          normalizeCertificateError(loadError.description)))
  )
  if (
    !canProceed ||
    !certificateFailure?.canProceed ||
    !expectedBrowserPageId ||
    certificateFailure.browserPageId !== expectedBrowserPageId ||
    certificateFailure.errorCode !== -202 ||
    !errorMatchesChallenge
  ) {
    return null
  }
  try {
    return new URL(loadError.validatedUrl).origin === certificateFailure.origin
      ? certificateFailure
      : null
  } catch {
    return null
  }
}

function formatCertificateProceedFailure(
  reason: BrowserCertificateProceedFailureReason | 'request-failed'
): string {
  if (reason === 'expired') {
    return translate(
      'browser.loadFailure.certificateChallengeExpired',
      'This certificate approval expired. Retry the page to request a new one.'
    )
  }
  if (reason === 'changed' || reason === 'navigated') {
    return translate(
      'browser.loadFailure.certificateChallengeChanged',
      'The certificate request changed. Retry the page and review the new warning.'
    )
  }
  if (reason === 'request-failed') {
    return translate(
      'browser.loadFailure.certificateProceedFailed',
      'Orca could not approve this certificate request. Retry the page and try again.'
    )
  }
  return translate(
    'browser.loadFailure.certificateChallengeUnavailable',
    'This certificate request is no longer available. Retry the page to request a new one.'
  )
}

export function BrowserLoadFailureOverlay({
  loadError,
  externalUrl,
  onRetry,
  onOpenExternal,
  certificateFailure,
  expectedBrowserPageId,
  onProceedCertificate,
  sshRoutedHint,
  onRecheckSshRoute,
  route = null,
  autoRetry
}: BrowserLoadFailureOverlayProps): React.JSX.Element {
  const connectingTimerRef = useRef<{
    challengeId: string
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const [proceedAttempt, setProceedAttempt] = useState<CertificateProceedAttempt | null>(null)
  const matchingCertificateFailure = getMatchingCertificateFailure({
    loadError,
    certificateFailure,
    expectedBrowserPageId,
    canProceed: Boolean(onProceedCertificate)
  })
  // Why: Chromium's error-page fallback can replace the diagnostic code with
  // -1 after main has already captured an exact live certificate challenge.
  const presentationLoadError =
    matchingCertificateFailure && loadError.code === -1
      ? {
          ...loadError,
          code: matchingCertificateFailure.errorCode ?? loadError.code,
          description: matchingCertificateFailure.error
        }
      : loadError
  const certificateError = isCertificateLoadError(presentationLoadError)
  const failure = describeBrowserLoadFailure(presentationLoadError, route)
  const description = formatLoadFailureDescription(presentationLoadError, failure, sshRoutedHint)
  const activeProceedAttempt =
    proceedAttempt?.challengeId === matchingCertificateFailure?.challengeId ? proceedAttempt : null
  const actionsDisabled = activeProceedAttempt?.state === 'submitting'

  useEffect(() => {
    return () => {
      if (connectingTimerRef.current) {
        clearTimeout(connectingTimerRef.current.timer)
        connectingTimerRef.current = null
      }
    }
  }, [matchingCertificateFailure?.challengeId])

  const proceedCertificate = (): void => {
    if (!matchingCertificateFailure || !onProceedCertificate || actionsDisabled) {
      return
    }
    const challengeId = matchingCertificateFailure.challengeId
    setProceedAttempt({ challengeId, state: 'submitting', showConnecting: false })
    connectingTimerRef.current = {
      challengeId,
      timer: setTimeout(() => {
        setProceedAttempt((current) =>
          current?.challengeId === challengeId && current.state === 'submitting'
            ? { ...current, showConnecting: true }
            : current
        )
      }, 200)
    }
    void onProceedCertificate(challengeId)
      .then((result) => {
        if (connectingTimerRef.current?.challengeId === challengeId) {
          clearTimeout(connectingTimerRef.current.timer)
          connectingTimerRef.current = null
        }
        if (!result.ok) {
          setProceedAttempt((current) =>
            current?.challengeId === challengeId
              ? {
                  challengeId,
                  state: 'failed',
                  showConnecting: false,
                  reason: result.reason
                }
              : current
          )
        }
      })
      .catch(() => {
        if (connectingTimerRef.current?.challengeId === challengeId) {
          clearTimeout(connectingTimerRef.current.timer)
          connectingTimerRef.current = null
        }
        setProceedAttempt((current) =>
          current?.challengeId === challengeId
            ? {
                challengeId,
                state: 'failed',
                showConnecting: false,
                reason: 'request-failed'
              }
            : current
        )
      })
  }
  const retryButton = (
    <Button
      size="sm"
      variant={certificateError && externalUrl ? 'outline' : 'default'}
      disabled={actionsDisabled}
      onClick={() => void onRetry()}
    >
      {translate('browser.loadFailure.retry', 'Retry')}
    </Button>
  )
  const certificateActions = (
    <>
      {externalUrl && onOpenExternal ? (
        <Button size="sm" disabled={actionsDisabled} onClick={() => onOpenExternal(externalUrl)}>
          {translate('browser.loadFailure.openExternally', 'Open Externally')}
        </Button>
      ) : null}
      {retryButton}
      {matchingCertificateFailure ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-48"
          disabled={actionsDisabled}
          onClick={proceedCertificate}
        >
          {activeProceedAttempt?.state === 'submitting' && activeProceedAttempt.showConnecting ? (
            <>
              <Loader2 className="animate-spin" />
              {translate('browser.loadFailure.connecting', 'Connecting…')}
            </>
          ) : (
            translate('browser.loadFailure.proceedUnsafe', 'Proceed Anyway (Unsafe)')
          )}
        </Button>
      ) : null}
    </>
  )
  return (
    <SecuritySurface>
      <div className="scrollbar-sleek absolute inset-0 z-20 overflow-y-auto bg-background">
        <div className="flex min-h-full items-center justify-center px-8 pt-12 pb-24">
          <div aria-live="polite" className="w-full max-w-lg">
            <h2 className="text-xl font-semibold text-balance text-foreground">
              {formatLoadFailureTitle(presentationLoadError, failure)}
            </h2>
            {description ? (
              <p className="mt-2 text-sm text-pretty text-muted-foreground">{description}</p>
            ) : null}
            {failure.errorName ? (
              <p className="mt-3 font-mono text-xs text-muted-foreground">{failure.errorName}</p>
            ) : null}
            {activeProceedAttempt?.state === 'failed' && activeProceedAttempt.reason ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {formatCertificateProceedFailure(activeProceedAttempt.reason)}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-2">
              {certificateError ? (
                certificateActions
              ) : (
                <>
                  {retryButton}
                  {onRecheckSshRoute ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="browser-load-failure-recheck-ssh-route"
                      onClick={onRecheckSshRoute}
                    >
                      {translate('browser.loadFailure.recheckSshRoute', 'Run connection check')}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
            <BrowserLoadFailureAutoRetryStatus
              failureKey={`${presentationLoadError.validatedUrl}\n${failure.kind}`}
              failure={failure}
              autoRetry={autoRetry}
              retry={onRetry}
            />
          </div>
        </div>
      </div>
    </SecuritySurface>
  )
}
