import { normalizeOptionalField } from './agent-status-field-normalization'

export const AGENT_CHILD_WORK_ID_MAX_LENGTH = 256

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(record)
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

/** A C0 control or DEL: never part of a record's one-line text. */
function isControlCharCode(code: number): boolean {
  return code <= 0x1f || code === 0x7f
}

/** A control character, or a code point a renderer draws as a line break (NEL, LS, PS). */
function breaksOneLineText(code: number): boolean {
  return isControlCharCode(code) || code === 0x85 || code === 0x2028 || code === 0x2029
}

/** The one text normalizer for a child record: the status-row preview, with anything that would
 *  break a one-line row folded to a space and the cut's edges trimmed. */
export function normalizeChildWorkText(raw: unknown, maxLength: number): string | undefined {
  const preview = normalizeOptionalField(raw, maxLength)
  if (preview === undefined) {
    return undefined
  }
  let text = ''
  for (let index = 0; index < preview.length; index += 1) {
    text += breaksOneLineText(preview.charCodeAt(index)) ? ' ' : preview[index]
  }
  return text.trim() || undefined
}

/** Exactly the normalizer's image, so the codec accepts every value admission can store. */
export function isChildWorkText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && normalizeChildWorkText(value, maxLength) === value
}

export function isChildWorkTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** An id: nonempty, trimmed, no control characters, within `maxLength`. */
export function isBoundedString(
  value: unknown,
  maxLength = AGENT_CHILD_WORK_ID_MAX_LENGTH
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim()
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    if (isControlCharCode(value.charCodeAt(index))) {
      return false
    }
  }
  return true
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
