/* eslint-disable max-lines -- Why: the update card owns the full updater lifecycle in one
   renderer surface. Keeping the state machine and its presentation variants together avoids
   scattering tightly coupled update behavior across multiple files. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { Progress } from './ui/progress'
import { AlertCircle, Check, Loader2, Minus, X } from 'lucide-react'
import type { ChangelogData } from '../../../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────

function releaseUrlForVersion(version: string | null): string {
  // Why: when no version is cached (typically a failed check), point at the
  // plain releases listing rather than /releases/latest — /latest also breaks
  // when GitHub's release API is degraded, and the listing is the most
  // reliable manual fallback.
  return version
    ? `https://github.com/stablyai/orca/releases/tag/v${version}`
    : 'https://github.com/stablyai/orca/releases'
}

function isAnimatedGif(url: string | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().endsWith('.gif')
}

type ErrorCardModel = {
  title: string
  summary: string
  message: string
  releaseUrl: string
  primaryAction?: {
    label: string
    onClick: () => void
  }
}

// ── Compact card (transient check feedback) ─────────────────────────

function CompactCardContent({
  icon,
  text,
  onClose,
  action
}: {
  icon: 'spinner' | 'check' | 'error'
  text: string
  onClose?: () => void
  action?: { label: string; url: string }
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="shrink-0 text-muted-foreground">
        {icon === 'spinner' && <Loader2 className="size-4 animate-spin" />}
        {icon === 'check' && <Check className="size-4" />}
        {icon === 'error' && <AlertCircle className="size-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{text}</p>
        {action && (
          <button
            className="text-xs text-muted-foreground underline hover:text-foreground mt-0.5"
            onClick={() => void window.api.shell.openUrl(action.url)}
          >
            {action.label}
          </button>
        )}
      </div>
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClose}
          aria-label="Dismiss"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────

export function UpdateCard() {
  const status = useAppStore((s) => s.updateStatus)
  const storeChangelog = useAppStore((s) => s.updateChangelog)
  const dismissedVersion = useAppStore((s) => s.dismissedUpdateVersion)
  const dismissUpdate = useAppStore((s) => s.dismissUpdate)
  const collapsed = useAppStore((s) => s.updateCardCollapsed)
  const setCollapsed = useAppStore((s) => s.setUpdateCardCollapsed)
  const reassuranceSeen = useAppStore((s) => s.updateReassuranceSeen)
  const markReassuranceSeen = useAppStore((s) => s.markUpdateReassuranceSeen)
  const hasStartedDownload = useRef(false)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  // Why: the version-based dismiss gate at the bottom of the visibility
  // section intentionally keeps error cards visible so a download failure
  // still surfaces even if the user previously dismissed the "available"
  // card for the same version.  But this means the error card's own X
  // button cannot hide the card via dismissUpdate alone.  A separate
  // local flag tracks whether the user has explicitly closed the error
  // card in this render cycle.
  const [errorDismissed, setErrorDismissed] = useState(false)
  // Why: "not-available" is transient feedback ("You're up to date") that
  // should auto-dismiss. A local flag avoids polluting the store with
  // timer state that no other component cares about.
  const [autoDismissed, setAutoDismissed] = useState(false)
  // Why: tracks whether the card is exiting so we can play the fade-out
  // animation before unmounting.
  const [exiting, setExiting] = useState(false)
  // Why: when the user explicitly clicks "Check for Updates", the dismiss gate
  // must be bypassed for the resulting 'available' card — otherwise the card
  // flashes "Checking..." then vanishes because the same version was previously
  // dismissed.  This ref tracks whether the current check cycle was user-initiated
  // so the dismiss gate can let the result through.
  const userInitiatedCycleRef = useRef(false)

  const changelog: ChangelogData | null = storeChangelog

  // Why: the 'error' variant of UpdateStatus does not carry a `version` field,
  // but the card needs the version for the "Download Manually" fallback URL
  // and for dismiss persistence. Cache it from states that do carry it.
  const versionRef = useRef<string | null>(null)
  if ('version' in status && status.version) {
    versionRef.current = status.version
  } else if (
    status.state === 'checking' ||
    status.state === 'idle' ||
    status.state === 'not-available'
  ) {
    // Why: a new check cycle has started or completed without an available update.
    // Clear the cached version so a later check failure cannot dismiss or link to
    // an unrelated older release that happened to be cached locally.
    versionRef.current = null
  }

  // Why: reset component-local state when a new update cycle begins. Without
  // this, stale flags from a previous version leak forward — e.g., a failed
  // image load for version A would suppress the hero for version B, or a
  // hasStartedDownload flag from version A would cause a Settings-initiated
  // download for version B to auto-restart.
  const prevVersionRef = useRef<string | null>(null)
  if (status.state === 'available' && status.version !== prevVersionRef.current) {
    prevVersionRef.current = status.version
    hasStartedDownload.current = false
    setMediaFailed(false)
    setMediaLoaded(false)
    setInstallError(null)
  }

  // Why: reset autoDismissed when a new status arrives so the card is
  // visible again for the next user-initiated check cycle.
  const prevStateRef = useRef(status.state)
  if (status.state !== prevStateRef.current) {
    prevStateRef.current = status.state
    if (autoDismissed) {
      setAutoDismissed(false)
    }
    if (exiting) {
      setExiting(false)
    }
    if (errorDismissed) {
      setErrorDismissed(false)
    }
  }

  const shouldAutoDismissLatest =
    status.state === 'not-available' && 'userInitiated' in status && Boolean(status.userInitiated)

  // Why: auto-dismiss "You're on the latest version" after 3 seconds.
  // The timer resets if the status changes before it fires.
  useEffect(() => {
    if (!shouldAutoDismissLatest) {
      return
    }
    const timer = setTimeout(() => setAutoDismissed(true), 3000)
    return () => clearTimeout(timer)
  }, [shouldAutoDismissLatest])

  // Why: quitAndInstall is a side effect that must not run during render —
  // React StrictMode double-invokes render functions, which would call
  // quitAndInstall twice. useEffect with a state guard is the safe path.
  // Gated on hasStartedDownload so a Settings-initiated download doesn't
  // auto-restart the app — the user expects to click "Restart" in Settings.
  useEffect(() => {
    if (status.state === 'downloaded' && hasStartedDownload.current) {
      void window.api.updater.quitAndInstall().catch((error) => {
        setInstallError(String((error as Error)?.message ?? error))
      })
    }
  }, [status.state])

  // ── Prefers-reduced-motion ──────────────────────────────────────────
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // ── Visibility gates ──────────────────────────────────────────────

  const isUserInitiated = 'userInitiated' in status && status.userInitiated
  const cachedVersion = versionRef.current
  const shouldShowDetailedErrorCard =
    status.state === 'error' && (hasStartedDownload.current || cachedVersion !== null)

  // Why: track whether the current check cycle was user-initiated so the
  // dismiss gate doesn't hide the result of an explicit "Check for Updates"
  // click.  Without this, clicking "Check for Updates" when a version was
  // previously dismissed causes the "Checking..." toast to flash briefly
  // then vanish — the 'available' card is suppressed by the dismiss gate
  // even though the user explicitly asked to see the result.
  if (status.state === 'checking' && isUserInitiated) {
    userInitiatedCycleRef.current = true
  } else if (status.state === 'idle' || (status.state === 'checking' && !isUserInitiated)) {
    userInitiatedCycleRef.current = false
  }

  // Compact transient states: only show for user-initiated checks.
  if (status.state === 'checking' && !isUserInitiated) {
    return null
  }
  if (status.state === 'not-available' && !isUserInitiated) {
    return null
  }
  if (status.state === 'not-available' && autoDismissed) {
    return null
  }

  // Background states that never show the card.
  if (status.state === 'idle') {
    return null
  }

  // Error: show card for user-initiated check failures or for failures tied to
  // a concrete cached update version (card-initiated and Settings-initiated
  // download/install flows). Background check failures stay silent.
  if (status.state === 'error' && !shouldShowDetailedErrorCard && !isUserInitiated) {
    return null
  }

  // Why: the version-based dismiss gate below intentionally keeps error cards
  // visible, but when the user explicitly clicks X on the error card itself
  // the card must disappear. This gate handles that case.
  if (status.state === 'error' && errorDismissed) {
    return null
  }

  // Dismiss gate: if the user previously dismissed this version, hide the card
  // for passive reminder states. Keep active in-progress/error states visible so
  // explicit install actions can still surface progress and failures.
  // Why: bypass the gate when the current cycle was user-initiated — the user
  // explicitly asked to check, so they expect to see the result even if they
  // dismissed the same version earlier.
  if (
    versionRef.current &&
    dismissedVersion === versionRef.current &&
    !userInitiatedCycleRef.current
  ) {
    if (status.state !== 'downloading' && status.state !== 'error') {
      return null
    }
  }

  if (
    collapsed &&
    (status.state === 'downloading' || status.state === 'downloaded' || status.state === 'error')
  ) {
    return null
  }

  // ── Shared helpers ────────────────────────────────────────────────

  const isRichMode = changelog?.release != null

  const handleUpdate = () => {
    hasStartedDownload.current = true
    // Why: clicking "Update" implies the user is not worried about interruption,
    // so dismiss the reassurance tip permanently.
    if (!reassuranceSeen) {
      markReassuranceSeen()
    }
    void window.api.updater.download()
  }

  // Why: the 'error' variant has no version field, so dismiss needs an
  // optional explicit version override for error/install-failure states.
  const handleClose = () => {
    // Why: clear the user-initiated bypass so the dismiss gate re-engages
    // immediately — otherwise the card would reappear on the next render
    // because the bypass ref still overrides the persisted dismissal.
    userInitiatedCycleRef.current = false
    if (status.state === 'error') {
      setErrorDismissed(true)
      if (cachedVersion) {
        dismissUpdate(cachedVersion)
      }
      return
    }
    dismissUpdate()
  }

  const handleInstallRetry = () => {
    void window.api.updater.quitAndInstall().catch((error) => {
      setInstallError(String((error as Error)?.message ?? error))
    })
  }

  const errorCard: ErrorCardModel | null =
    status.state === 'error'
      ? {
          // Why: title is scoped to the operation that failed so check-time
          // failures (commonly GitHub-side) don't read as a bug in Orca.
          title: cachedVersion ? 'Update Error' : 'Update Check Failed',
          summary: cachedVersion
            ? 'Could not complete the update.'
            : 'Could not check for updates.',
          message: status.message,
          releaseUrl: releaseUrlForVersion(cachedVersion),
          primaryAction: cachedVersion
            ? {
                label: 'Retry Download',
                onClick: handleUpdate
              }
            : undefined
        }
      : installError
        ? {
            title: 'Update Error',
            summary: 'Could not restart to install the update.',
            message: installError,
            releaseUrl: releaseUrlForVersion(cachedVersion),
            primaryAction: {
              label: 'Try Again',
              onClick: handleInstallRetry
            }
          }
        : null

  const handleDismissWithAnimation = () => {
    if (prefersReducedMotion) {
      handleClose()
      return
    }
    setExiting(true)
    setTimeout(handleClose, 150)
  }

  // Why: long-running phases (downloading, downloaded, error) minimize to the
  // status bar instead of persistently dismissing. A dismiss during an active
  // download would orphan the in-flight download with no surfaced recovery.
  const handleCollapseWithAnimation = () => {
    if (prefersReducedMotion) {
      setCollapsed(true)
      return
    }
    setExiting(true)
    setTimeout(() => {
      setCollapsed(true)
      setExiting(false)
    }, 150)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') {
      return
    }
    e.preventDefault()
    if (
      status.state === 'downloading' ||
      status.state === 'downloaded' ||
      status.state === 'error'
    ) {
      handleCollapseWithAnimation()
    } else {
      handleDismissWithAnimation()
    }
  }

  // ── Dynamic aria-label ────────────────────────────────────────────

  const ariaLabel =
    status.state === 'checking'
      ? 'Checking for updates'
      : status.state === 'not-available'
        ? "You're on the latest version"
        : status.state === 'available'
          ? 'Update available'
          : status.state === 'downloading'
            ? 'Downloading update'
            : status.state === 'downloaded'
              ? 'Update ready to install'
              : status.state === 'error'
                ? 'Update error'
                : 'Update status'

  // ── Card wrapper ──────────────────────────────────────────────────

  const animationClass = prefersReducedMotion
    ? ''
    : exiting
      ? 'animate-update-card-exit'
      : 'animate-update-card-enter'

  const cardContent = (() => {
    // ── Compact transient states (user-initiated check feedback) ──────

    if (status.state === 'checking') {
      return <CompactCardContent icon="spinner" text="Checking for updates..." />
    }

    if (status.state === 'not-available') {
      return <CompactCardContent icon="check" text="You're on the latest version." />
    }

    // ── Error states ─────────────────────────────────────────────────

    if (errorCard) {
      return (
        <ErrorCardContent
          title={errorCard.title}
          summary={errorCard.summary}
          message={errorCard.message}
          releaseUrl={errorCard.releaseUrl}
          primaryAction={errorCard.primaryAction}
          onClose={handleCollapseWithAnimation}
        />
      )
    }

    // ── Downloaded state ─────────────────────────────────────────────

    if (status.state === 'downloaded') {
      if (hasStartedDownload.current) {
        return (
          <div className="p-4">
            <p className="text-sm">Installing...</p>
          </div>
        )
      }
      // Settings-initiated download — show "Ready to install"
      return (
        <ReadyToInstallContent
          version={status.version}
          onRestart={handleInstallRetry}
          onClose={handleCollapseWithAnimation}
        />
      )
    }

    // ── Downloading state ────────────────────────────────────────────

    if (status.state === 'downloading') {
      return (
        <DownloadingContent
          version={status.version}
          percent={status.percent}
          changelog={changelog}
          prefersReducedMotion={prefersReducedMotion}
          mediaFailed={mediaFailed}
          mediaLoaded={mediaLoaded}
          onMediaError={() => setMediaFailed(true)}
          onMediaLoad={() => setMediaLoaded(true)}
          onCollapse={handleCollapseWithAnimation}
        />
      )
    }

    // ── Available state ──────────────────────────────────────────────

    if (status.state !== 'available') {
      return null
    }

    const releaseUrl =
      ('releaseUrl' in status ? status.releaseUrl : undefined) ??
      releaseUrlForVersion(status.version)

    if (isRichMode && changelog) {
      return (
        <RichCardContent
          release={changelog.release}
          releasesBehind={changelog.releasesBehind}
          prefersReducedMotion={prefersReducedMotion}
          mediaFailed={mediaFailed}
          mediaLoaded={mediaLoaded}
          onMediaError={() => setMediaFailed(true)}
          onMediaLoad={() => setMediaLoaded(true)}
          onUpdate={handleUpdate}
          onClose={handleDismissWithAnimation}
        />
      )
    }

    return (
      <SimpleCardContent
        version={status.version}
        releaseUrl={releaseUrl}
        onUpdate={handleUpdate}
        onClose={handleDismissWithAnimation}
      />
    )
  })()

  // Why: show a one-time reassurance tip above the card so first-time users
  // know updating won't kill their running terminals. Once seen, persisted
  // to disk so it never reappears.
  const showReassurance =
    !reassuranceSeen && (status.state === 'available' || status.state === 'downloading')

  return (
    <div
      className="fixed bottom-10 right-4 z-40 w-[360px] max-w-[calc(100vw-32px)] flex flex-col gap-2
      max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto"
    >
      {showReassurance && (
        <Card className={`py-0 gap-0 ${animationClass}`}>
          <div className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                Your terminal sessions won&apos;t be interrupted during the update.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={markReassuranceSeen}
              aria-label="Dismiss tip"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </Card>
      )}
      <Card
        role="complementary"
        aria-label={ariaLabel}
        aria-live="polite"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={`py-0 gap-0 ${animationClass}`}
      >
        {cardContent}
      </Card>
    </div>
  )
}

// ── Rich card content ────────────────────────────────────────────────

function RichCardContent({
  release,
  releasesBehind,
  prefersReducedMotion,
  mediaFailed,
  mediaLoaded,
  onMediaError,
  onMediaLoad,
  onUpdate,
  onClose
}: {
  release: NonNullable<ChangelogData['release']>
  releasesBehind: number | null
  prefersReducedMotion: boolean
  mediaFailed: boolean
  mediaLoaded: boolean
  onMediaError: () => void
  onMediaLoad: () => void
  onUpdate: () => void
  onClose: () => void
}) {
  const showMedia =
    release.mediaUrl &&
    !mediaFailed &&
    // Why: when prefers-reduced-motion is active, hide animated GIFs entirely
    // rather than showing a frozen frame (GIFs cannot be reliably paused
    // cross-browser). Static images are shown normally since they produce no motion.
    !(prefersReducedMotion && isAnimatedGif(release.mediaUrl))

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">New: {release.title}</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label="Dismiss update"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {showMedia && (
        <div className="relative overflow-hidden rounded-md">
          {!mediaLoaded && (
            // Shimmer placeholder while image loads
            <div
              className="w-full bg-muted/50 animate-pulse rounded-md"
              style={{ aspectRatio: '16/9' }}
            />
          )}
          <img
            src={release.mediaUrl}
            alt=""
            className={`w-full rounded-md ${mediaLoaded ? '' : 'absolute inset-0'}`}
            style={!mediaLoaded ? { visibility: 'hidden' } : undefined}
            onError={onMediaError}
            onLoad={onMediaLoad}
          />
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {release.description}
        {releasesBehind !== null && releasesBehind > 1 && (
          <>
            {' '}
            <button
              className="text-xs text-muted-foreground/70 underline hover:text-foreground inline"
              onClick={() => void window.api.shell.openUrl(release.releaseNotesUrl)}
            >
              +{releasesBehind - 1} more since your last update
            </button>
          </>
        )}
      </p>

      <button
        className="text-xs text-muted-foreground underline hover:text-foreground self-start"
        onClick={() => void window.api.shell.openUrl(release.releaseNotesUrl)}
      >
        Read the full release notes
      </button>

      <Button variant="default" size="sm" onClick={onUpdate} className="w-full">
        Update
      </Button>
    </div>
  )
}

// ── Simple card content ──────────────────────────────────────────────

function SimpleCardContent({
  version,
  releaseUrl,
  onUpdate,
  onClose
}: {
  version: string
  releaseUrl: string
  onUpdate: () => void
  onClose: () => void
}) {
  return (
    <div className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">Update Available</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label="Dismiss update"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">Orca v{version} is ready.</p>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Sessions won&apos;t be interrupted.
      </p>

      <button
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground self-start"
        onClick={() => void window.api.shell.openUrl(releaseUrl)}
      >
        Release notes
      </button>

      <Button variant="default" size="sm" onClick={onUpdate} className="mt-0.5 w-full">
        Update
      </Button>
    </div>
  )
}

// ── Downloading content ──────────────────────────────────────────────

function DownloadingContent({
  version,
  percent,
  changelog,
  prefersReducedMotion,
  mediaFailed,
  mediaLoaded,
  onMediaError,
  onMediaLoad,
  onCollapse
}: {
  version: string
  percent: number
  changelog: ChangelogData | null
  prefersReducedMotion: boolean
  mediaFailed: boolean
  mediaLoaded: boolean
  onMediaError: () => void
  onMediaLoad: () => void
  onCollapse: () => void
}) {
  const release = changelog?.release
  const showMedia =
    release?.mediaUrl && !mediaFailed && !(prefersReducedMotion && isAnimatedGif(release.mediaUrl))

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        {release ? (
          <h3 className="text-sm font-semibold">New: {release.title}</h3>
        ) : (
          <h3 className="text-sm font-semibold">Downloading Update</h3>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onCollapse}
          aria-label="Minimize to status bar"
        >
          <Minus className="size-3.5" />
        </Button>
      </div>

      {showMedia && release?.mediaUrl && (
        <div className="relative overflow-hidden rounded-md">
          {!mediaLoaded && (
            <div
              className="w-full bg-muted/50 animate-pulse rounded-md"
              style={{ aspectRatio: '16/9' }}
            />
          )}
          <img
            src={release.mediaUrl}
            alt=""
            className={`w-full rounded-md ${mediaLoaded ? '' : 'absolute inset-0'}`}
            style={!mediaLoaded ? { visibility: 'hidden' } : undefined}
            onError={onMediaError}
            onLoad={onMediaLoad}
          />
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {release ? release.description : `Orca v${version} is downloading.`}
      </p>

      <button
        className="text-xs text-muted-foreground underline hover:text-foreground self-start"
        onClick={() =>
          void window.api.shell.openUrl(
            release ? release.releaseNotesUrl : releaseUrlForVersion(version)
          )
        }
      >
        {release ? 'Read the full release notes' : 'Release notes'}
      </button>

      <div className="flex flex-col gap-2 mt-1">
        <Progress value={percent} className="h-1.5" />
        <p className="text-xs text-muted-foreground">Downloading... {percent}%</p>
      </div>
    </div>
  )
}

// ── Error card content ───────────────────────────────────────────────

function ErrorCardContent({
  title,
  summary,
  message,
  releaseUrl,
  primaryAction,
  onClose
}: {
  title: string
  summary: string
  message: string
  releaseUrl: string
  primaryAction?: {
    label: string
    onClick: () => void
  }
  onClose: () => void
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label="Minimize to status bar"
        >
          <Minus className="size-3.5" />
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        {summary} {message}
      </p>

      <div className="flex gap-2">
        {primaryAction && (
          <Button variant="default" size="sm" onClick={primaryAction.onClick} className="flex-1">
            {primaryAction.label}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void window.api.shell.openUrl(releaseUrl)}
          className={primaryAction ? 'flex-1' : 'w-full'}
        >
          Download Manually
        </Button>
      </div>
    </div>
  )
}

// ── Ready to install content ─────────────────────────────────────────

function ReadyToInstallContent({
  version,
  onRestart,
  onClose
}: {
  version: string
  onRestart: () => void
  onClose: () => void
}) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">Ready to Install</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label="Minimize to status bar"
        >
          <Minus className="size-3.5" />
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Orca v{version} is downloaded. Restart when you&apos;re ready.
      </p>

      <Button variant="default" size="sm" onClick={onRestart} className="w-full">
        Restart to Update
      </Button>
    </div>
  )
}
