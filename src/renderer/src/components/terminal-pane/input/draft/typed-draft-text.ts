const BACKSPACE = '\x7f'
const CTRL_H = '\b'

/** Ignore control/escape input so drafts cannot submit; Backspace deletes and pasted line breaks become spaces. */
export function appendTypedDraftText(draft: string, data: string, maxCodeUnits: number): string {
  if (data.startsWith('\x1b')) {
    return draft
  }
  const isPasteChunk = data.length > 1
  let next = draft
  let pendingSpace = false
  for (const char of data) {
    if (char === BACKSPACE || char === CTRL_H) {
      next = Array.from(next).slice(0, -1).join('')
      continue
    }
    if (isPasteChunk && (char === '\r' || char === '\n')) {
      pendingSpace = next !== '' && !/\s$/.test(next)
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue
    }
    if (pendingSpace && next.length < maxCodeUnits) {
      next += ' '
    }
    pendingSpace = false
    if (next.length + char.length > maxCodeUnits) {
      break
    }
    next += char
  }
  return next
}
