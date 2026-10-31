import { useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export const QUICK_CHAT_EVENT = 'orca:quick-chat'
export const QUICK_CHAT_FINISHED_EVENT = 'orca:quick-chat-finished'

export function requestQuickChat(anchor: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(QUICK_CHAT_EVENT, { detail: anchor }))
}

export function requestQuickChatFromShortcut(): void {
  const clickControl = () => {
    const anchor =
      document.querySelector<HTMLButtonElement>('[data-quick-chat="landing"]') ??
      document.querySelector<HTMLButtonElement>('[data-quick-chat="sidebar"]')
    anchor?.click()
  }
  const store = useAppStore.getState()
  if (!document.querySelector('[data-quick-chat]') || !store.sidebarOpen) {
    store.setActiveView('terminal')
    store.setSidebarOpen(true)
    requestAnimationFrame(clickControl)
  } else {
    clickControl()
  }
}

export function QuickChatButton({ landing = false }: { landing?: boolean }) {
  useUiLanguageRevision()
  const hasProjects = useAppStore((s) => s.repos.length > 0)
  const [started, setStarted] = useState(false)
  const shortcut = useOptionalShortcutLabel('chat.quickStart')
  const label = translate('quickChat.newChat', 'New chat')
  // Keep the clicked landing control mounted until its launch or picker finishes.
  if (landing && hasProjects && !started) {
    return null
  }
  const button = (
    <Button
      variant={landing ? 'secondary' : 'ghost'}
      size={landing ? 'default' : 'icon-xs'}
      className={landing ? undefined : 'w-8 text-muted-foreground'}
      data-quick-chat={landing ? 'landing' : 'sidebar'}
      aria-label={label}
      onClick={(event) => {
        setStarted(true)
        event.currentTarget.addEventListener(QUICK_CHAT_FINISHED_EVENT, () => setStarted(false), {
          once: true
        })
        requestQuickChat(event.currentTarget)
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
