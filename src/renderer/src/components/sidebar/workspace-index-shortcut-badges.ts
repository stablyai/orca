import { useEffect, useMemo, useState } from 'react'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { useAppStore } from '@/store'
import {
  getDigitIndexModifierChords,
  keybindingModifierChordsEqual,
  type KeybindingModifierChord
} from '../../../../shared/keybindings'
import type { HostSectionRow } from './host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from './worktree-list/grouping/row-types'
import { getRenderedWorktreeEntriesInSidebarOrder } from './worktree-sidebar-row-preference'

const WORKSPACE_INDEX_ACTION_ID = 'workspace.selectByIndex' as const
/** Only 1-9 are addressable, so deeper cards get no badge. */
const WORKSPACE_INDEX_SHORTCUT_MAX = 9
// Why: ordinary chords (Cmd+C, Cmd+S) release well inside this, so the badges don't strobe on every shortcut.
const BADGE_HOLD_DELAY_MS = 400
const NO_WORKSPACE_INDEX_BADGES: ReadonlyMap<string, number> = new Map()

function readModifierChord(event: KeyboardEvent): KeybindingModifierChord {
  return {
    meta: event.metaKey,
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey
  }
}

/** True while the user holds the modifiers of their own workspace.selectByIndex binding, Safari-tab-numbers style. */
export function useWorkspaceIndexShortcutHeld(): boolean {
  const keybindings = useAppStore((state) => state.keybindings)
  const chords = useMemo(
    () =>
      getDigitIndexModifierChords(WORKSPACE_INDEX_ACTION_ID, getRendererAppPlatform(), keybindings),
    [keybindings]
  )
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (chords.length === 0) {
      setHeld(false)
      return
    }
    let shown = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const hide = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (shown) {
        shown = false
        setHeld(false)
      }
    }
    const sync = (event: KeyboardEvent): void => {
      const pressed = readModifierChord(event)
      if (!chords.some((chord) => keybindingModifierChordsEqual(chord, pressed))) {
        hide()
        return
      }
      if (shown || timer) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        shown = true
        setHeld(true)
      }, BADGE_HOLD_DELAY_MS)
    }
    window.addEventListener('keydown', sync, true)
    window.addEventListener('keyup', sync, true)
    // Why: a chord that moves focus off the window (Cmd+Tab, a browser guest) never delivers its keyup here.
    window.addEventListener('blur', hide)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('keydown', sync, true)
      window.removeEventListener('keyup', sync, true)
      window.removeEventListener('blur', hide)
      document.removeEventListener('visibilitychange', hide)
      hide()
    }
  }, [chords])

  return held
}

/**
 * Row key -> the digit that jumps to that card, empty unless the chord is held and can act.
 *
 * Why this row walk: it is the one the sidebar's shortcut cache publishes
 * (`setVisibleWorktreeShortcutTargets`), so a badge can never label a card the
 * shortcut would not actually activate.
 */
export function useWorkspaceShortcutIndexByRowKey(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): ReadonlyMap<string, number> {
  const held = useWorkspaceIndexShortcutHeld()
  // Why: the jump handler ignores the chord outside the terminal view, and hands it to Cmd+J's
  // rows while the palette is open. Badging cards the digits would not reach is worse than none.
  const cardsAreAddressable = useAppStore(
    (state) => state.activeView === 'terminal' && state.activeModal !== 'worktree-palette'
  )
  return useMemo(() => {
    if (!held || !cardsAreAddressable) {
      return NO_WORKSPACE_INDEX_BADGES
    }
    const entries = getRenderedWorktreeEntriesInSidebarOrder(rows, pinnedDisplayPolicy)
    const byRowKey = new Map<string, number>()
    const labelled = Math.min(entries.length, WORKSPACE_INDEX_SHORTCUT_MAX)
    for (let index = 0; index < labelled; index++) {
      byRowKey.set(entries[index]!.rowKey, index + 1)
    }
    return byRowKey
  }, [cardsAreAddressable, held, pinnedDisplayPolicy, rows])
}
