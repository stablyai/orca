const BRACKETED_PASTE_BEGIN = '\u001b[200~'
const BRACKETED_PASTE_END = '\u001b[201~'

export function sanitizeTerminalDraftText(content: string): string {
  return content.replaceAll('\u001b', '\u241b')
}

export function toSafeTerminalDraftPaste(content: string): string {
  const normalized = content.replace(/\r?\n/g, '\r')
  return `${BRACKETED_PASTE_BEGIN}${sanitizeTerminalDraftText(normalized)}${BRACKETED_PASTE_END}`
}
