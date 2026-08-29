import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChangelogData } from '../../../shared/update-status-types'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { useAppStore } from '../store'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'
import { UpdateCardStateContent } from './maintenance/update-card/UpdateCardStateContent'
import { buildUpdateCardErrorModel } from './maintenance/update-card/update-card-error-model'
import {
  getUpdateCardAriaLabel,
  isHttp2ProtocolError,
  isUpdateCardVisible
} from './maintenance/update-card/update-card-visibility'

export { isHttp2ProtocolError }

export function UpdateCard(): React.JSX.Element | null {
  const status = useAppStore((state) => state.updateStatus)
  const changelog: ChangelogData | null = useAppStore((state) => state.updateChangelog)
  const updateUserInitiatedCycle = useAppStore((state) => state.updateUserInitiatedCycle)
  const dismissedVersion = useAppStore((state) => state.dismissedUpdateVersion)
  const dismissUpdate = useAppStore((state) => state.dismissUpdate)
  const collapsed = useAppStore((state) => state.updateCardCollapsed)
  const setCollapsed = useAppStore((state) => state.setUpdateCardCollapsed)
  const reassuranceSeen = useAppStore((state) => state.updateReassuranceSeen)
  const markReassuranceSeen = useAppStore((state) => state.markUpdateReassuranceSeen)
  const hasStartedDownload = useRef(false)
  const dismissAnimationTimerRef = useRef<number | null>(null)
  const collapseAnimationTimerRef = useRef<number | null>(null)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [compatibilityRelaunching, setCompatibilityRelaunching] = useState(false)
  const [compatibilitySetupError, setCompatibilitySetupError] = useState<string | null>(null)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [autoDismissed, setAutoDismissed] = useState(false)
  const [exiting, setExiting] = useState(false)
  const isLocalBuild = status.source === 'local'
  const versionRef = useRef<string | null>(null)
  if ('version' in status && status.version) {
    versionRef.current = status.version
  } else if (
    status.state === 'checking' ||
    status.state === 'idle' ||
    status.state === 'not-available'
  ) {
    versionRef.current = null
  }
  const prevVersionRef = useRef<string | null>(null)
  if (status.state === 'available' && status.version !== prevVersionRef.current) {
    prevVersionRef.current = status.version
    hasStartedDownload.current = false
    setMediaFailed(false)
    setMediaLoaded(false)
    setInstallError(null)
  }
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
  useEffect(() => {
    if (!shouldAutoDismissLatest) {
      return
    }
    const timer = window.setTimeout(() => setAutoDismissed(true), 3000)
    return () => window.clearTimeout(timer)
  }, [shouldAutoDismissLatest])
  useEffect(() => {
    if (status.state === 'downloaded' && hasStartedDownload.current) {
      void window.api.updater.quitAndInstall().catch((error) => {
        setInstallError(String((error as Error)?.message ?? error))
      })
    }
  }, [status.state])

  const prefersReducedMotion = usePrefersReducedMotion()
  const clearAnimationTimers = useCallback(() => {
    if (dismissAnimationTimerRef.current !== null) {
      window.clearTimeout(dismissAnimationTimerRef.current)
      dismissAnimationTimerRef.current = null
    }
    if (collapseAnimationTimerRef.current !== null) {
      window.clearTimeout(collapseAnimationTimerRef.current)
      collapseAnimationTimerRef.current = null
    }
  }, [])
  const cardRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node === null) {
        clearAnimationTimers()
      }
    },
    [clearAnimationTimers]
  )
  const cachedVersion = versionRef.current
  if (
    !isUpdateCardVisible({
      status,
      dismissedVersion,
      cachedVersion,
      hasStartedDownload: hasStartedDownload.current,
      updateUserInitiatedCycle,
      autoDismissed,
      errorDismissed,
      collapsed
    })
  ) {
    return null
  }

  const handleUpdate = (): void => {
    hasStartedDownload.current = true
    if (!reassuranceSeen) {
      markReassuranceSeen()
    }
    void window.api.updater.download()
  }
  const handleClose = (): void => {
    if (status.state === 'error') {
      setErrorDismissed(true)
      if (cachedVersion) {
        dismissUpdate(cachedVersion)
      }
      return
    }
    dismissUpdate()
  }
  const handleInstallRetry = (): void => {
    void window.api.updater.quitAndInstall().catch((error) => {
      setInstallError(String((error as Error)?.message ?? error))
    })
  }
  const handleEnableHttp1Compatibility = (): void => {
    if (compatibilityRelaunching) {
      return
    }
    setCompatibilityRelaunching(true)
    setCompatibilitySetupError(null)
    void window.api.settings
      .set({ electronHttp1CompatibilityMode: true })
      .then(() => window.api.app.relaunch())
      .catch((error) => {
        const message = String((error as Error)?.message ?? error)
        console.error('[updates] failed to enable HTTP/1.1 compatibility:', error)
        setCompatibilitySetupError(`Could not enable compatibility mode. ${message}`)
        setCompatibilityRelaunching(false)
      })
  }
  const errorCard = buildUpdateCardErrorModel({
    status,
    isLocalBuild,
    cachedVersion,
    installError,
    compatibilityRelaunching,
    compatibilitySetupError,
    onChooseLocalBuild: () => void window.api.updater.check({ localBuild: true }),
    onEnableHttp1Compatibility: handleEnableHttp1Compatibility,
    onRetryDownload: handleUpdate,
    onRecheck: () => void window.api.updater.check({ includePrerelease: false }),
    onInstallRetry: handleInstallRetry
  })
  const linuxPackageRecovery =
    status.state === 'error' && status.recovery?.kind === 'linux-package-install'
      ? { recovery: status.recovery, diagnostic: status.message }
      : null

  const handleDismissWithAnimation = (): void => {
    if (prefersReducedMotion) {
      handleClose()
      return
    }
    setExiting(true)
    if (dismissAnimationTimerRef.current !== null) {
      window.clearTimeout(dismissAnimationTimerRef.current)
    }
    dismissAnimationTimerRef.current = window.setTimeout(() => {
      dismissAnimationTimerRef.current = null
      handleClose()
    }, 150)
  }
  const handleCollapseWithAnimation = (): void => {
    if (prefersReducedMotion) {
      setCollapsed(true)
      return
    }
    setExiting(true)
    if (collapseAnimationTimerRef.current !== null) {
      window.clearTimeout(collapseAnimationTimerRef.current)
    }
    collapseAnimationTimerRef.current = window.setTimeout(() => {
      collapseAnimationTimerRef.current = null
      setCollapsed(true)
      setExiting(false)
    }, 150)
  }
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
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

  const cardContent = (
    <UpdateCardStateContent
      status={status}
      changelog={changelog}
      errorCard={errorCard}
      linuxPackageRecovery={linuxPackageRecovery}
      isLocalBuild={isLocalBuild}
      cachedVersion={cachedVersion}
      hasStartedDownload={hasStartedDownload.current}
      prefersReducedMotion={prefersReducedMotion}
      mediaFailed={mediaFailed}
      mediaLoaded={mediaLoaded}
      onMediaError={() => setMediaFailed(true)}
      onMediaLoad={() => setMediaLoaded(true)}
      onUpdate={handleUpdate}
      onInstallRetry={handleInstallRetry}
      onDismiss={handleDismissWithAnimation}
      onCollapse={handleCollapseWithAnimation}
    />
  )

  const animationClass = prefersReducedMotion
    ? ''
    : exiting
      ? 'animate-update-card-exit'
      : 'animate-update-card-enter'
  const showReassurance =
    !reassuranceSeen && (status.state === 'available' || status.state === 'downloading')
  return (
    <div
      ref={cardRootRef}
      className="fixed bottom-10 right-4 z-40 w-[360px] max-w-[calc(100vw-32px)] flex flex-col gap-2 max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto"
    >
      {showReassurance && (
        <Card className={`py-0 gap-0 ${animationClass}`}>
          <div className="flex items-center gap-3 p-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.UpdateCard.b1d867f4fb',
                  "Your terminal sessions won't be interrupted during the update."
                )}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={markReassuranceSeen}
              aria-label={translate('auto.components.UpdateCard.7274ef6e59', 'Dismiss tip')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </Card>
      )}
      <Card
        role="complementary"
        aria-label={getUpdateCardAriaLabel(status)}
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
