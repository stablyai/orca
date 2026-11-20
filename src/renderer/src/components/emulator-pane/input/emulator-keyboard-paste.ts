import { buildServeSimKeyboardFramesForKey } from '../../../../../shared/emulator/emulator-keyboard-frame'
import { measureUtf8ByteLength } from '../../../../../shared/text/utf8-byte-limits'

export const EMULATOR_KEYBOARD_PASTE_MAX_BYTES = 4 * 1024

export type EmulatorKeyboardPasteResult =
  | {
      byteLength: number
      status: 'sent'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'unsupported-text' | 'target-unavailable'
      status: 'rejected'
    }

type EmulatorKeyboardPasteValidation =
  | {
      byteLength: number
      status: 'accepted'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'unsupported-text'
      status: 'rejected'
    }

function validateEmulatorKeyboardPasteText(
  text: string,
  options: { maxBytes?: number; usKeyboardOnly: boolean }
): EmulatorKeyboardPasteValidation {
  const byteLimit = getPositiveIntegerLimit(options.maxBytes, EMULATOR_KEYBOARD_PASTE_MAX_BYTES)
  const byteLengthMeasurement = measureUtf8ByteLength(text, { stopAfterBytes: byteLimit })
  if (byteLengthMeasurement.exceededLimit) {
    return { byteLength: byteLengthMeasurement.byteLength, reason: 'too-large', status: 'rejected' }
  }
  const { byteLength } = byteLengthMeasurement
  let hasText = false

  for (const char of text) {
    if (char === '\r') {
      continue
    }
    if (options.usKeyboardOnly && !buildServeSimKeyboardFramesForKey(char)) {
      return { byteLength, reason: 'unsupported-text', status: 'rejected' }
    }
    hasText = true
  }

  return hasText
    ? { byteLength, status: 'accepted' }
    : { byteLength, reason: 'empty', status: 'rejected' }
}

/**
 * Simulator panes send the whole text to main for one pasteboard paste; Android's scrcpy text
 * injection only types US keyboard text.
 */
export async function pasteTextIntoEmulator({
  maxBytes,
  send,
  text,
  usKeyboardOnly
}: {
  maxBytes?: number
  send: (text: string) => Promise<boolean>
  text: string
  usKeyboardOnly: boolean
}): Promise<EmulatorKeyboardPasteResult> {
  const validation = validateEmulatorKeyboardPasteText(text, { maxBytes, usKeyboardOnly })
  if (validation.status === 'rejected') {
    return validation
  }
  if (!(await send(text))) {
    return { byteLength: validation.byteLength, reason: 'target-unavailable', status: 'rejected' }
  }
  return { byteLength: validation.byteLength, status: 'sent' }
}

function getPositiveIntegerLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}
