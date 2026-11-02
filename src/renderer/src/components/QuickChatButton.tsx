import { useSyncExternalStore } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { quickChatConfirmation } from '@/lib/quick-chat-confirmation'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { Button } from './ui/button'

// Until the Start chatting dialog exists, confirm its pre-filled answers at once.
function startChatting(): void {
  void quickChatConfirmation.open().then(() => quickChatConfirmation.confirm())
}

export function QuickChatButton() {
  useUiLanguageRevision()
  const hasProjects = useAppStore((s) => s.repos.length > 0)
  // Keep the control while its answers are open, so registering Chats cannot hide a retry.
  const open = useSyncExternalStore(
    quickChatConfirmation.subscribe,
    () => quickChatConfirmation.read().open
  )
  if (isWebClientLocation() || (hasProjects && !open)) {
    return null
  }
  return (
    <Button variant="secondary" onClick={startChatting}>
      <MessageSquarePlus className="size-4" />
      {translate('quickChat.startChatting', 'Start chatting')}
    </Button>
  )
}
