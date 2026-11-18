import { useEffect, useState } from 'react'
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
  return (
    // Stay out of flow so adding or removing the history row cannot shift the transcript.
    <div
      ref={olderHistory.sentinelRef}
      className="absolute inset-x-0 top-0 flex h-10 items-center justify-center"
    >
      {olderHistory.isAutoLoadEnabled ? (
        <span role="status" aria-live="polite" className="text-xs text-chat-foreground-faint">
          {loadingEarlier ? <DelayedLoadingLabel /> : null}
        </span>
      ) : olderHistory.loadFailed && !loadingEarlier ? (
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
      ) : (
        <Button
          variant="ghost"
          size="xs"
          onClick={olderHistory.loadEarlierManually}
          disabled={loadingEarlier}
        >
          {loadingEarlier
            ? t('components.native-chat.loadingEarlier', 'Loading…')
            : t('components.native-chat.loadEarlier', 'Load earlier messages')}
        </Button>
      )}
    </div>
  )
}
