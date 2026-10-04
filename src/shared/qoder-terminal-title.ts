import { isDshTerminalTitle } from './dsh-terminal-title'

// Qoder 1.1.64: one space after the glyph, then a session title and a pipe-delimited status.
const QODER_DYNAMIC_TITLE_RE = /^[✦◇▲] (?! ).*\s\|\s[^|]+$/
const QODER_LABEL_RE = /^(?:[✦◇▲] )?Qoder CLI(?: CN)?(?: \(.*\))?$/

export function isQoderTerminalTitle(title: string): boolean {
  if (isDshTerminalTitle(title)) {
    return false
  }
  const trimmed = title.trim()
  return QODER_DYNAMIC_TITLE_RE.test(trimmed) || QODER_LABEL_RE.test(trimmed)
}

export function qoderTitleStatus(title: string): 'working' | 'permission' | 'idle' | null {
  if (!isQoderTerminalTitle(title)) {
    return null
  }
  const glyph = title.trimStart()[0]
  return glyph === '✦' ? 'working' : glyph === '▲' ? 'permission' : 'idle'
}
