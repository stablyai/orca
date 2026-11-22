import { measureUtf8ByteLength } from '../../../../../shared/text/utf8-byte-limits'

export const EMULATOR_KEYBOARD_PASTE_MAX_BYTES = 4 * 1024

export type EmulatorKeyboardPasteResult =
  | {
      byteLength: number
      status: 'sent'
    }
  | {
      byteLength: number
      reason: 'empty' | 'too-large' | 'target-unavailable'
      status: 'rejected'
    }

/** Both platforms paste the whole text through the device clipboard, so any text is accepted. */
export async function pasteTextIntoEmulator({
  maxBytes,
  send,
  text
}: {
  maxBytes?: number
  send: (text: string) => Promise<boolean>
  text: string
}): Promise<EmulatorKeyboardPasteResult> {
  const byteLimit = getPositiveIntegerLimit(maxBytes, EMULATOR_KEYBOARD_PASTE_MAX_BYTES)
  const { byteLength, exceededLimit } = measureUtf8ByteLength(text, { stopAfterBytes: byteLimit })
  if (exceededLimit) {
    return { byteLength, reason: 'too-large', status: 'rejected' }
  }
  if (!text.replaceAll('\r', '')) {
    return { byteLength, reason: 'empty', status: 'rejected' }
  }
  if (!(await send(text))) {
    return { byteLength, reason: 'target-unavailable', status: 'rejected' }
  }
  return { byteLength, status: 'sent' }
}

function getPositiveIntegerLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback
}
