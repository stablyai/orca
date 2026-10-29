import { isWebClientLocation } from '@/lib/web-client-location'
import {
  logicalKeyTokenFromInput,
  physicalCodeKeyTokenFromInput
} from '../../../../shared/keybindings'

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

type ClipboardChordEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

export type NativeClipboardChordCommand = 'copy' | 'cut' | 'paste'

/** The chords that make Chromium run its native copy, cut or paste command. */
export function getNativeClipboardChordCommand(
  event: ClipboardChordEvent,
  isMac: boolean
): NativeClipboardChordCommand | null {
  // Non-Latin layouts report the typed letter in key; Chromium still acts on the physical key.
  const key = logicalKeyTokenFromInput(event) ?? physicalCodeKeyTokenFromInput(event)
  const letterCommand = key === 'C' ? 'copy' : key === 'X' ? 'cut' : key === 'V' ? 'paste' : null
  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      ? letterCommand
      : null
  }
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    // Ctrl+Shift+V also pastes on Windows/Linux; Ctrl+Shift+C and X are other browser shortcuts.
    if (event.shiftKey) {
      return letterCommand === 'paste' ? 'paste' : null
    }
    return letterCommand ?? (event.key === 'Insert' ? 'copy' : null)
  }
  if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return event.key === 'Insert' ? 'paste' : event.key === 'Delete' ? 'cut' : null
  }
  return null
}

// Only native paste chords can use ClipboardEvent on insecure web; consume remapped chords to avoid sending control characters.
export function firesNativePasteEvent(event: ClipboardChordEvent, isMac: boolean): boolean {
  return getNativeClipboardChordCommand(event, isMac) === 'paste'
}
