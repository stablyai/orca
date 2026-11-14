import { useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatDockFit, useNativeChatDockFitToken } from './use-native-chat-dock-fit'

/** Everything under the transcript: strips, queue, prompt cards and the composer, fitted to the pane's room. */
export function NativeChatDock({ children }: { children: React.ReactNode }): React.JSX.Element {
  const t = useTranslate()
  const dockRef = useRef<HTMLDivElement>(null)
  useNativeChatDockFit(dockRef)
  // The last fallback scrolls the dock itself; only then is it a focusable region for arrow and Page keys.
  const scrolls = useNativeChatDockFitToken(dockRef, 'dock')
  return (
    <div
      ref={dockRef}
      data-native-chat-dock
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? 'region' : undefined}
      aria-label={
        scrolls ? t('components.native-chat.dock.label', 'Message box and prompts') : undefined
      }
      className="scrollbar-sleek flex min-h-0 shrink flex-col outline-none [[data-native-chat-dock-fit~=dock]_&]:overflow-y-auto [[data-native-chat-dock-fit~=dock]_&>*]:shrink-0!"
    >
      {children}
    </div>
  )
}
