import { useCallback, useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  requestQuickChat,
  QUICK_CHAT_FINISHED_EVENT,
  QUICK_CHAT_ANCHOR_EVENT
} from '@/lib/quick-chat-events'
export {
  requestQuickChat,
  requestQuickChatFromShortcut,
  QUICK_CHAT_EVENT,
  QUICK_CHAT_FINISHED_EVENT
} from '@/lib/quick-chat-events'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function QuickChatButton({ landing = false }: { landing?: boolean }) {
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
    window.dispatchEvent(new CustomEvent(QUICK_CHAT_ANCHOR_EVENT, { detail: control }))
    return () => {
      control.removeEventListener(QUICK_CHAT_FINISHED_EVENT, finished)
      window.dispatchEvent(new CustomEvent(QUICK_CHAT_ANCHOR_EVENT, { detail: null }))
    }
  }, [control])
  const shortcut = useOptionalShortcutLabel('chat.quickStart')
  const label = translate('quickChat.newChat', 'New chat')
  // Keep the clicked landing control mounted until its launch or picker finishes.
  if (isWebClientLocation() || (landing && hasProjects && !started)) {
    return null
  }
  const button = (
    <Button
      ref={publish}
      variant={landing ? 'secondary' : 'ghost'}
      size={landing ? 'default' : 'icon-xs'}
      className={landing ? undefined : 'w-8'}
      data-quick-chat={landing ? 'landing' : 'sidebar'}
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
      {landing && translate('quickChat.startChatting', 'Start chatting')}
    </Button>
  )
  return landing ? (
    button
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {shortcut ? `${label} (${shortcut})` : label}
      </TooltipContent>
    </Tooltip>
  )
}
