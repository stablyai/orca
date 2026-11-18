import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  // The scroller that keyboard focus returns to when the focused manual button goes away.
  const focusOwner = useRef<HTMLElement | null>(null)
  const restoreFocus = useCallback(() => {
    const scroller = focusOwner.current
    focusOwner.current = null
    scroller?.focus({ preventScroll: true })
  }, [])
  const failed = olderHistory.loadFailed && !loadingEarlier
  // Auto-loading and the failure row both replace the manual button.
  useLayoutEffect(() => {
    if (olderHistory.isAutoLoadEnabled || failed) {
      restoreFocus()
    }
    return restoreFocus
  }, [failed, olderHistory.isAutoLoadEnabled, restoreFocus])
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
          onFocus={(event) => {
            focusOwner.current = event.currentTarget.closest('[data-native-chat-scroll]')
          }}
          onBlur={() => {
            focusOwner.current = null
          }}
        >
          {loadingEarlier
            ? t('components.native-chat.loadingEarlier', 'Loading…')
            : t('components.native-chat.loadEarlier', 'Load earlier messages')}
        </Button>
      )}
    </div>
  )
}
