const MAX_CELL_TEXT_LENGTH = 4096

/** Grid text for one decoded Parquet value; nulls stay blank like empty CSV cells. */
export function parquetCellText(value: unknown): string {
  const text = parquetValueText(value)
  return text.length > MAX_CELL_TEXT_LENGTH ? `${text.slice(0, MAX_CELL_TEXT_LENGTH)}…` : text
}

function parquetValueText(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString()
  }
  if (value instanceof Uint8Array) {
    return parquetBytesText(value)
  }
  return JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === 'bigint'
      ? nested.toString()
      : nested instanceof Uint8Array
        ? parquetBytesText(nested)
        : nested
  )
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Legacy writers store strings as unannotated BYTE_ARRAY, so show valid printable UTF-8 as text. */
function parquetBytesText(bytes: Uint8Array): string {
  try {
    const text = strictUtf8.decode(bytes)
    if (!hasBinaryControlCharacter(text)) {
      return text
    }
  } catch {
    // Not UTF-8: fall through to hex.
  }
  return parquetBytesHex(bytes)
}

/** Control characters other than tab, newline and carriage return mark the bytes as binary. */
function hasBinaryControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true
    }
  }
  return false
}

function parquetBytesHex(bytes: Uint8Array): string {
  const shown = Array.from(bytes.subarray(0, 64), (byte) => byte.toString(16).padStart(2, '0'))
  return `0x${shown.join('')}${bytes.length > 64 ? '…' : ''}`
}
