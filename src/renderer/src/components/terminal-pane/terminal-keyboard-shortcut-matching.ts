import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { safeFind } from '../terminal-search-safe-find'
import { resolveTerminalShortcutAction, type MacOptionAsAlt } from './terminal-shortcut-policy'
import {
  keybindingMatchesAction,
  type KeybindingOverrides,
  type KeybindingPlatform,
  type TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import { isFindQueryTooLarge } from '@/lib/find-query-bounds'
import { recordCreatedTerminalPaneSplit } from './terminal-pane-split-completion'

export function resolveTerminalKeyboardShortcutAction(
  event: Parameters<typeof resolveTerminalShortcutAction>[0],
  isMac: Parameters<typeof resolveTerminalShortcutAction>[1],
  macOptionAsAlt: Parameters<typeof resolveTerminalShortcutAction>[2],
  optionKeyLocations: Parameters<typeof resolveTerminalShortcutAction>[3],
  isWindows: Parameters<typeof resolveTerminalShortcutAction>[4],
  keybindings: Parameters<typeof resolveTerminalShortcutAction>[5],
  isLocalWindowsConptyPane: Parameters<typeof resolveTerminalShortcutAction>[6],
  getKittyKeyboardFlagsActivePane: Parameters<typeof resolveTerminalShortcutAction>[7],
  layoutCharacterForCode: Parameters<typeof resolveTerminalShortcutAction>[8],
  getWindowsShiftEnterEncoding: Parameters<typeof resolveTerminalShortcutAction>[9],
  isWindowsTerminalHost: NonNullable<Parameters<typeof resolveTerminalShortcutAction>[10]>,
  terminalShortcutPolicy: Parameters<typeof resolveTerminalShortcutAction>[11] = 'orca-first',
  hasCtrlEnterCsiUAuthority?: Parameters<typeof resolveTerminalShortcutAction>[12]
): ReturnType<typeof resolveTerminalShortcutAction> {
  return resolveTerminalShortcutAction(
    event,
    isMac,
    macOptionAsAlt,
    optionKeyLocations,
    isWindows,
    keybindings,
    isLocalWindowsConptyPane,
    getKittyKeyboardFlagsActivePane,
    layoutCharacterForCode,
    getWindowsShiftEnterEncoding,
    isWindowsTerminalHost,
    terminalShortcutPolicy,
    hasCtrlEnterCsiUAuthority
  )
}

export function recordKeyboardCreatedTerminalPaneSplit(
  createdPane: unknown,
  args: { source: 'contextual_tour' | 'keyboard'; direction: 'vertical' | 'horizontal' }
): boolean {
  return recordCreatedTerminalPaneSplit(createdPane, args)
}

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
  const options = { caseSensitive: searchState.caseSensitive, regex: searchState.regex }
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

export type { MacOptionAsAlt }
