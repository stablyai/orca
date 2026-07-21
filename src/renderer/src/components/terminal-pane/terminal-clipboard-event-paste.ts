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
