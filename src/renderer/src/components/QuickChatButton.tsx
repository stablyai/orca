import { useCallback, useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { requestQuickChat, QUICK_CHAT_FINISHED_EVENT } from '@/lib/quick-chat-events'
export {
  requestQuickChat,
  QUICK_CHAT_EVENT,
  QUICK_CHAT_FINISHED_EVENT
} from '@/lib/quick-chat-events'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { Button } from './ui/button'

export function QuickChatButton() {
  useUiLanguageRevision()
  const hasProjects = useAppStore((s) => s.repos.length > 0)
  const [started, setStarted] = useState(false)
  const requests = useRef(new Set<string>())
  const [control, setControl] = useState<HTMLButtonElement | null>(null)
  const publish = useCallback((node: HTMLButtonElement | null) => setControl(node), [])
  useEffect(() => {
    if (!control) {
      return
    }
    const finished = (event: Event) => {
      if (event instanceof CustomEvent && requests.current.delete(event.detail)) {
        setStarted(requests.current.size > 0)
      }
    }
    control.addEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
    return () => {
      control.removeEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
    }
  }, [control])
  const label = translate('quickChat.newChat', 'New chat')
  // Keep the clicked landing control mounted until its launch or picker finishes.
  if (isWebClientLocation() || (hasProjects && !started)) {
    return null
  }
  return (
    <Button
      ref={publish}
      variant="secondary"
      data-quick-chat="landing"
      aria-label={label}
      onClick={(event) => {
        const id = requestQuickChat(event.currentTarget)
        if (id) {
          requests.current.add(id)
          setStarted(true)
        }
      }}
    >
      <MessageSquarePlus className="size-4" />
      {translate('quickChat.startChatting', 'Start chatting')}
    </Button>
  )
}
