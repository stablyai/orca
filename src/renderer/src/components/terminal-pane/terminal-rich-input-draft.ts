import type { JSONContent } from '@tiptap/core'
import { TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE } from './terminal-rich-input-model'

const MAX_TERMINAL_RICH_INPUT_DRAFTS = 128

type TerminalRichInputDraftEntry = {
  text: string
  content: JSONContent | null
}

const drafts = new Map<string, TerminalRichInputDraftEntry>()

export function readTerminalRichInputDraft(scopeKey: string): string {
  return readDraftEntry(scopeKey)?.text ?? ''
}

export function readTerminalRichInputDraftContent(scopeKey: string): JSONContent | null {
  return readDraftEntry(scopeKey)?.content ?? null
}

export function writeTerminalRichInputDraft(
  scopeKey: string,
  draft: string,
  content: JSONContent | null = null
): void {
  drafts.delete(scopeKey)
  if (!draft && !hasImageAttachment(content)) {
    return
  }
  drafts.set(scopeKey, { text: draft, content })
  while (drafts.size > MAX_TERMINAL_RICH_INPUT_DRAFTS) {
    const oldest = drafts.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    drafts.delete(oldest)
  }
}

export function clearTerminalRichInputDraftsForTests(): void {
  drafts.clear()
}

function readDraftEntry(scopeKey: string): TerminalRichInputDraftEntry | undefined {
  const entry = drafts.get(scopeKey)
  if (entry) {
    // Refresh insertion order so active panes survive bounded eviction.
    drafts.delete(scopeKey)
    drafts.set(scopeKey, entry)
  }
  return entry
}

function hasImageAttachment(content: JSONContent | null): boolean {
  if (!content) {
    return false
  }
  if (content.type === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
    return true
  }
  return (content.content ?? []).some(hasImageAttachment)
}
