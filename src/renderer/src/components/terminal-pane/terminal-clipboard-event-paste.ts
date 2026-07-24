import { isWebClientLocation } from '@/lib/web-client-location'

// Why: navigator.clipboard only exists in secure contexts. The web client served
// over plain HTTP (e.g. a LAN address) can reach the clipboard only through the
// chord's native ClipboardEvent, so Ctrl/Cmd+V must not be preventDefault-ed there.
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

// Why: only these chords make the browser dispatch a native `paste` ClipboardEvent,
// the sole clipboard path on insecure web. A remapped terminal.paste chord (e.g. Ctrl+Y)
// fires no paste event, so it must still be consumed rather than encoded to the PTY as
// raw control chars.
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
    event.key === 'Insert' &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  )
}
