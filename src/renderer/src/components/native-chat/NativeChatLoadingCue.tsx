import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

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
      <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}
