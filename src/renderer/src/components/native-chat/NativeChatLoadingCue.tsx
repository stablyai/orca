import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '@/components/LoadingSpinner'

/** The structured chat's pane while its first read runs. No visible text, and a CSS animation
 *  delay keeps it invisible unless the read lasts, so a quick read paints nothing. */
export function NativeChatLoadingCue(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label={translate('components.native-chat.state.loading.label', 'Loading chat')}
      data-native-chat-loading-cue="true"
      className="flex h-full w-full items-center justify-center animate-in fade-in delay-250 [--tw-animation-fill-mode:backwards]"
    >
      <LoadingSpinner className="size-5 text-muted-foreground" />
    </div>
  )
}
