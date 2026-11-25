import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'

/** The viewer's own keys: ⌘↵ sends, ⌘Z undoes (⇧ redoes), C toggles Annotate, ← → step between a
 *  message's images, and ⇧C hides the notes panel. Keys typed into a field are left alone. */
export function handleNativeChatMediaViewerKey(
  event: React.KeyboardEvent,
  viewer: {
    send: () => void
    undo: () => boolean
    redo: () => boolean
    canAnnotate: boolean
    annotating: boolean
    toggleAnnotating: () => void
    step: { previous: (() => void) | null; next: (() => void) | null } | null
    togglePanel: () => void
  }
): void {
  const typing =
    event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
  const command = isMacPlatform() ? event.metaKey : event.ctrlKey
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey
  if (event.key === 'Enter' && command) {
    event.preventDefault()
    viewer.send()
    return
  }
  if (typing) {
    return
  }
  if (event.key.toLowerCase() === 'z' && command) {
    // As in Orca's markup: any change to the notes undoes, and with Shift redoes.
    if (event.shiftKey ? viewer.redo() : viewer.undo()) {
      event.preventDefault()
    }
  } else if (event.key === 'c' && !event.metaKey && !event.ctrlKey && viewer.canAnnotate) {
    event.preventDefault()
    viewer.toggleAnnotating()
  } else if (viewer.step && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const go = event.key === 'ArrowLeft' ? viewer.step.previous : viewer.step.next
    if (go && plain) {
      event.preventDefault()
      go()
    }
  } else if (event.key === 'C' && event.shiftKey && plain && viewer.annotating) {
    event.preventDefault()
    viewer.togglePanel()
  }
}
