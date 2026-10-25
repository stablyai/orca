import { isWebClientLocation } from '@/lib/web-client-location'

// Insecure web origins lack navigator.clipboard; preserve the native paste gesture as their only clipboard path.
export function shouldUseClipboardEventPaste(args: {
  isWebClient: boolean
  clipboardReadTextAvailable: boolean
}): boolean {
  return args.isWebClient && !args.clipboardReadTextAvailable
}

export function isClipboardEventPasteRequired(): boolean {
  return shouldUseClipboardEventPaste({
    isWebClient: isWebClientLocation(),
    clipboardReadTextAvailable: typeof navigator.clipboard?.readText === 'function'
  })
}

export function getClipboardEventText(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/plain') ?? ''
}

type PasteChordEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

// Only native paste chords can use ClipboardEvent on insecure web; consume remapped chords to avoid sending control characters.
export function firesNativePasteEvent(event: PasteChordEvent, isMac: boolean): boolean {
  const key = event.key.toLowerCase()
  if (isMac) {
    return key === 'v' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  }
  // Ctrl+V and Ctrl+Shift+V both dispatch a native paste event on Windows/Linux.
  if (key === 'v' && event.ctrlKey && !event.metaKey && !event.altKey) {
    return true
  }
  return (
    event.key === 'Insert' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  )
}
