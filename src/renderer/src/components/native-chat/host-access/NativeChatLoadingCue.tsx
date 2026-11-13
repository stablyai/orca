import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '@/components/LoadingSpinner'

/** Delay the loading animation so fast initial reads paint no cue. */
export function NativeChatLoadingCue(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      aria-label={t('components.native-chat.state.loading.label', 'Loading chat')}
      data-native-chat-loading-cue="true"
      className="flex h-full w-full items-center justify-center animate-in fade-in delay-250 [--tw-animation-fill-mode:backwards]"
    >
      <LoadingSpinner className="size-5 text-chat-foreground-faint" />
    </div>
  )
}
