import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { safeFind } from '../../../terminal-search-safe-find'
import { buildTerminalSearchOptions } from '../../../terminal-search-options'
import '../../../../../../shared/keybindings'
import { keybindingMatchesAction } from '../../../../../../shared/keybindings/matching'
import type {
  KeybindingOverrides,
  KeybindingPlatform,
  TerminalShortcutPolicy
} from '../../../../../../shared/keybindings/types'
import { isFindQueryTooLarge } from '@/lib/find-query-bounds'

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

export type SearchState = { query: string; caseSensitive: boolean; regex: boolean }
export type SearchNavigationDirection = 'next' | 'previous'

export function matchSearchNavigate(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
  searchOpen: boolean,
  searchState: SearchState
): SearchNavigationDirection | null {
  if (e.altKey) {
    return null
  }
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.key.toLowerCase() !== 'g' || !searchOpen || !searchState.query) {
    return null
  }
  if (isFindQueryTooLarge(searchState.query)) {
    return null
  }
  return e.shiftKey ? 'previous' : 'next'
}

export function runTerminalSearchNavigation(
  pane: Pick<ManagedPane, 'searchAddon'>,
  direction: SearchNavigationDirection,
  searchState: SearchState
): boolean {
  const options = buildTerminalSearchOptions(searchState)
  return direction === 'next'
    ? safeFind(
        (term, findOptions) => pane.searchAddon.findNext(term, findOptions),
        searchState.query,
        options
      )
    : safeFind(
        (term, findOptions) => pane.searchAddon.findPrevious(term, findOptions),
        searchState.query,
        options
      )
}

export function matchFileSearchShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'>,
  platform: KeybindingPlatform,
  keybindings?: KeybindingOverrides,
  terminalShortcutPolicy: TerminalShortcutPolicy = 'orca-first'
): boolean {
  if (e.repeat) {
    return false
  }
  return keybindingMatchesAction('sidebar.search.toggle', e, platform, keybindings, {
    context: 'terminal',
    terminalShortcutPolicy
  })
}
