import { useCallback, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BrowserDriverState } from '@/lib/pane-manager/browser-mobile-driver-state'
import { translate } from '@/i18n/i18n'

type Props = {
  driver: BrowserDriverState
  onTakeBack: () => void | Promise<void>
}

const OVERLAY_TITLE_ID = 'browser-mobile-driver-overlay-title'

export function BrowserMobileDriverOverlay({ driver, onTakeBack }: Props): ReactElement | null {
  const [pending, setPending] = useState(false)
  const [takeBackFailed, setTakeBackFailed] = useState(false)
  const mountedRef = useRef(false)

  const setOverlayRef = useCallback((node: HTMLDivElement | null): void => {
    mountedRef.current = node !== null
    if (node) {
      // Why: take-back can resolve after the overlay renders null; a later
      // mobile session must not inherit the stale disabled state.
      setPending(false)
      setTakeBackFailed(false)
    }
  }, [])

  if (driver.kind !== 'mobile') {
    return null
  }

  const handleTakeBack = async (): Promise<void> => {
    if (pending) {
      return
    }
    setPending(true)
    setTakeBackFailed(false)
    try {
      await onTakeBack()
    } catch {
      // Why: the reclaim RPC can fail (runtime gone, phone still holding the lock).
      // Surface it and leave the button enabled instead of silently re-locking.
      if (mountedRef.current) {
        setTakeBackFailed(true)
      }
    } finally {
      if (mountedRef.current) {
        setPending(false)
      }
    }
  }

  return (
    <div
      ref={setOverlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={OVERLAY_TITLE_ID}
      aria-live="assertive"
      className={cn(
        'pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm',
        'mobile-browser-driver-banner'
      )}
    >
      <div className="pointer-events-auto flex w-full max-w-[30rem] flex-col gap-3 rounded-lg border border-border bg-card p-6 pb-5 text-card-foreground shadow-xs">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <span aria-hidden="true">●</span>
          <span>
            {translate(
              'auto.components.browser.pane.BrowserMobileDriverOverlay.20539eca03',
              'Mobile is driving this browser'
            )}
          </span>
        </div>
        <div id={OVERLAY_TITLE_ID} className="text-base font-semibold leading-tight">
          {translate(
            'auto.components.browser.pane.BrowserMobileDriverOverlay.d9768ec642',
            'Browser input is paused'
          )}
        </div>
        <div className="text-sm leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.browser.pane.BrowserMobileDriverOverlay.f4ecd61552',
            'This tab is being controlled from your phone. Take back to use it on desktop.'
          )}
        </div>
        {takeBackFailed ? (
          <div role="alert" className="text-sm leading-relaxed text-destructive">
            {translate(
              'auto.components.browser.pane.BrowserMobileDriverOverlay.7c31b0da94',
              "Couldn't take back this tab. Check the phone session, then try again."
            )}
          </div>
        ) : null}
        <div className="mt-1 flex justify-end">
          {/* autoFocus puts keyboard users on the recovery action when the lock appears. */}
          <Button type="button" size="sm" onClick={handleTakeBack} disabled={pending} autoFocus>
            {translate(
              'auto.components.browser.pane.BrowserMobileDriverOverlay.a6914ee43f',
              'Take back'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
