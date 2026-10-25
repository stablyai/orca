import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import {
  createDomTextSearchHighlights,
  findDomTextSearchRanges,
  type DomTextSearchInstance,
  type DomTextSearchScope
} from '../../lib/dom-text-search-highlights'
export {
  findTextMatchRanges,
  isTextSearchQueryTooLarge as isMarkdownPreviewSearchQueryTooLarge,
  TEXT_SEARCH_QUERY_MAX_BYTES as MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES,
  type TextMatchOptions
} from '../../lib/text-match-ranges'

export function isMarkdownPreviewFindShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.find', event, platform, keybindings)
}

export function isMarkdownPreviewReplaceShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.replace', event, platform, keybindings)
}

// Why: react-markdown owns the preview DOM; matches are painted as CSS highlights
// (see dom-text-search-highlights.ts). The static names below must match the
// ::highlight() selectors in markdown-preview.css.
const previewHighlights = createDomTextSearchHighlights({
  match: 'markdown-preview-search-match',
  active: 'markdown-preview-search-active-match'
})

/** Per-preview identity for the highlight maps; only compared by reference. */
export type MarkdownPreviewSearchInstance = DomTextSearchInstance

const DOCUMENT_ONLY_SCOPE: DomTextSearchScope = {
  rejectElement: (element) =>
    element.closest(
      '.markdown-annotation-controls,[data-orca-export-hide],.code-block-copy-btn,.mermaid-block'
    ) !== null,
  joinedTextSelector: 'code'
}

export function clearMarkdownPreviewSearchHighlights(
  instanceId: MarkdownPreviewSearchInstance
): void {
  previewHighlights.clear(instanceId)
}

export function applyMarkdownPreviewSearchHighlights(
  instanceId: MarkdownPreviewSearchInstance,
  root: HTMLElement,
  query: string,
  options: { documentOnly?: boolean } = {}
): Range[] {
  const ranges = findDomTextSearchRanges(
    root,
    query,
    options.documentOnly ? DOCUMENT_ONLY_SCOPE : {}
  )
  previewHighlights.setMatches(instanceId, ranges)
  return ranges
}

export function setActiveMarkdownPreviewSearchMatch(
  instanceId: MarkdownPreviewSearchInstance,
  matches: readonly Range[],
  activeIndex: number,
  options: { scrollIntoView?: boolean } = {}
): void {
  const active = activeIndex >= 0 ? matches[activeIndex] : undefined
  previewHighlights.setActive(instanceId, active)

  if (active && options.scrollIntoView !== false) {
    // The Range's start container is a Text node; scroll its element into view.
    active.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }
}
