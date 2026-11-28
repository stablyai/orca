import { useRef } from 'react'
import { useKeepFloatingTerminalTriggerClear } from '@/components/floating-terminal/trigger/floating-terminal-trigger-keep-clear'
import { useTranslate } from '@/i18n/use-translate'
import { useNativeChatDockFit, useNativeChatDockFitToken } from './use-native-chat-dock-fit'

/** Everything under the transcript: strips, queue, prompt cards and the composer, fitted to the pane's room. */
export function NativeChatDock({
  shown = true,
  keepFloatingTerminalTriggerClear = false,
  children
}: {
  /** False (a chat whose history can never load) leaves no dock at all. */
  shown?: boolean
  keepFloatingTerminalTriggerClear?: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  // A separate mount, so the fit's observers start with the dock's box and stop (clearing the root's
  // fit attribute) when it goes.
  return shown ? (
    <NativeChatDockBox keepFloatingTerminalTriggerClear={keepFloatingTerminalTriggerClear}>
      {children}
    </NativeChatDockBox>
  ) : null
}

function NativeChatDockBox({
  children,
  keepFloatingTerminalTriggerClear
}: {
  children: React.ReactNode
  keepFloatingTerminalTriggerClear: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const dockRef = useRef<HTMLDivElement>(null)
  useNativeChatDockFit(dockRef)
  useKeepFloatingTerminalTriggerClear(dockRef, keepFloatingTerminalTriggerClear)
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
      // Once the transcript gives up its floor, the dock reaches the pane top: clear the pane's title actions.
      className="scrollbar-sleek flex min-h-0 shrink flex-col focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [[data-native-chat-dock-fit~=transcript]_&]:pt-[var(--orca-pane-title-height,calc(var(--spacing)*6))] [[data-native-chat-dock-fit~=dock]_&]:overflow-y-auto [[data-native-chat-dock-fit~=dock]_&>*]:shrink-0!"
    >
      {children}
    </div>
  )
}

/** The transcript above a fitted dock: it keeps a sliver of room until the dock's fallbacks give it
 *  up, and even then the worker chip's height, so the chip floating at its end never covers the dock. */
export function NativeChatDockTranscript({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-[calc(var(--spacing)*20)] flex-1 flex-col [[data-native-chat-dock-fit~=transcript]_&]:min-h-[var(--native-chat-worker-chip-floor,0px)]">
      {children}
    </div>
  )
}
