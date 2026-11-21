import { useEffect, useEffectEvent, type RefObject } from 'react'
import { useAppStore } from '@/store/index'
import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'

export function useNativeChatStructuredEscapeStop({
  rootRef,
  onStop,
  visible,
  defaultOwner
}: {
  rootRef: RefObject<HTMLDivElement | null>
  onStop: (() => void) | undefined
  visible: boolean
  defaultOwner: boolean
}): void {
  const stopOnEscape = useEffectEvent((event: KeyboardEvent, root: HTMLDivElement) => {
    if (
      !onStop ||
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.isComposing ||
      event.repeat ||
      isEditableTarget(event.target) ||
      hasVisibleOverlay()
    ) {
      return
    }
    const owner = event
      .composedPath()
      .find((node) => node instanceof Element && node.hasAttribute('data-native-chat-root'))
    // With a sidebar open, only the pane in the event path can claim Escape.
    if (owner ? owner !== root : !defaultOwner || useAppStore.getState().rightSidebarOpen) {
      return
    }
    event.preventDefault()
    onStop()
  })

  useEffect(() => {
    const root = rootRef.current
    if (!visible || !root) {
      return
    }
    // Run after the editor, suggestions, prompt cards and other Escape owners.
    const doc = root.ownerDocument
    const handleKeyDown = (event: KeyboardEvent) => stopOnEscape(event, root)
    doc.addEventListener('keydown', handleKeyDown)
    return () => doc.removeEventListener('keydown', handleKeyDown)
  }, [rootRef, visible])
}
