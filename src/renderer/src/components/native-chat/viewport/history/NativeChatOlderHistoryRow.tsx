import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatOlderHistoryAutoload } from './use-native-chat-older-history-autoload'

/** Pages that land quickly (local reads) should not flash a label. */
const LOADING_LABEL_DELAY_MS = 200

function DelayedLoadingLabel(): React.JSX.Element | null {
  const t = useTranslate()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_LABEL_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return visible ? (
    <>{t('components.native-chat.loadingEarlierMessages', 'Loading earlier messages…')}</>
  ) : null
}

/** Keep the sentinel directly under the positioned scroller; offer manual loading only after auto-loading stops. */
export function NativeChatOlderHistoryRow({
  olderHistory,
  loadingEarlier
}: {
  olderHistory: NativeChatOlderHistoryAutoload
  loadingEarlier: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const failed = olderHistory.loadFailed && !loadingEarlier
  const shown = failed ? 'retry' : olderHistory.isAutoLoadEnabled ? 'status' : 'load'
  // Keyboard continuity for Load and Retry: a focused control replaced by another hands focus to
  // it; replaced by nothing, focus waits on the scroller until the pending load settles, and goes
  // to a new Retry if that load fails again. Once the reader moves focus, nothing is moved.
  const control = useRef<HTMLButtonElement | null>(null)
  const focusedFrom = useRef<HTMLElement | null>(null)
  const parkedOn = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    const lost = !active || active === document.body
    const scroller = focusedFrom.current
    if (scroller && lost) {
      focusedFrom.current = null
      if (control.current) {
        control.current.focus({ preventScroll: true })
      } else {
        scroller.focus({ preventScroll: true })
        parkedOn.current = scroller
      }
      return
    }
    const parked = parkedOn.current
    if (!parked) {
      return
    }
    if (active !== parked) {
      parkedOn.current = null
    } else if (shown === 'retry' && control.current) {
      parkedOn.current = null
      control.current.focus({ preventScroll: true })
    } else if (!loadingEarlier) {
      parkedOn.current = null
    }
  }, [loadingEarlier, shown])
  // The row itself goes away once the history is complete; its focused control hands back too.
  useLayoutEffect(
    () => () => {
      focusedFrom.current?.focus({ preventScroll: true })
    },
    []
  )
  const focusHandlers = {
    ref: control,
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
      focusedFrom.current = event.currentTarget.closest('[data-native-chat-scroll]')
    },
    onBlur: () => {
      focusedFrom.current = null
    }
  }
  return (
    // Stay out of flow so adding or removing the history row cannot shift the transcript.
    <div
      ref={olderHistory.sentinelRef}
      className="absolute inset-x-0 top-0 flex h-10 items-center justify-center"
    >
      {failed ? (
        <span className="flex max-w-full min-w-0 items-center gap-2 px-3 text-xs">
          <span role="alert" className="min-w-0 truncate text-destructive">
            {t('components.native-chat.loadEarlierFailed', "Couldn't load earlier messages.")}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={olderHistory.loadEarlierManually}
            {...focusHandlers}
          >
            {t('components.native-chat.loadEarlierRetry', 'Retry')}
          </Button>
        </span>
      ) : olderHistory.isAutoLoadEnabled ? (
        <span role="status" aria-live="polite" className="text-xs text-chat-foreground-faint">
          {loadingEarlier ? <DelayedLoadingLabel /> : null}
        </span>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={loadingEarlier ? undefined : olderHistory.loadEarlierManually}
          aria-disabled={loadingEarlier}
          aria-busy={loadingEarlier}
          {...focusHandlers}
        >
          {loadingEarlier
            ? t('components.native-chat.loadingEarlier', 'Loading…')
            : t('components.native-chat.loadEarlier', 'Load earlier messages')}
        </Button>
      )}
    </div>
  )
}
