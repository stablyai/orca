// Why: pure, unit-testable text transforms behind the notes editor's
// link-embedding ergonomics. Kept separate from the React component so the
// selection math can be tested without a DOM.

export type TextEdit = {
  text: string
  selectionStart: number
  selectionEnd: number
}

// Why: detect that clipboard text is a single URL so a paste-over-selection can
// wrap it as a markdown link. Deliberately strict — must be one whitespace-free
// http(s)/www token — so ordinary prose pastes fall through to default behavior.
export function isLikelyUrl(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return false
  }
  return /^https?:\/\/\S+$/i.test(trimmed) || /^www\.\S+$/i.test(trimmed)
}

// Wrap the current selection as [selectedText](url); caret lands after the link.
export function wrapSelectionAsLink(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  url: string
): TextEdit {
  const selected = value.slice(selectionStart, selectionEnd)
  const link = `[${selected}](${url.trim()})`
  const text = value.slice(0, selectionStart) + link + value.slice(selectionEnd)
  const caret = selectionStart + link.length
  return { text, selectionStart: caret, selectionEnd: caret }
}

// Insert a markdown-link scaffold and SELECT the url placeholder so the user can
// type the URL inline. Uses the selection as the link label, or "text" when the
// selection is empty.
export function insertLinkScaffold(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  placeholder = 'url'
): TextEdit {
  const selected = value.slice(selectionStart, selectionEnd)
  const label = selected.length > 0 ? selected : 'text'
  const link = `[${label}](${placeholder})`
  const text = value.slice(0, selectionStart) + link + value.slice(selectionEnd)
  const urlStart = selectionStart + `[${label}](`.length
  return { text, selectionStart: urlStart, selectionEnd: urlStart + placeholder.length }
}
