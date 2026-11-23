import { useSyncExternalStore } from 'react'
import { matchKeybindingDigitIndex } from '../../../../shared/keybindings/matching'
import type { KeybindingOverrides } from '../../../../shared/keybindings/types'
import { useAppStore } from '@/store/index'
import { getShortcutPlatform } from './shortcut-platform'

export type IndexShortcutAction = 'workspace.selectByIndex' | 'tab.selectByIndex'
export type IndexShortcutHints = Readonly<Record<IndexShortcutAction, boolean>>

type HeldModifiers = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

// Why a delay: a quick Cmd+C or Ctrl+click must not flash numbers over the sidebar and the tabs.
const SHOW_DELAY_MS = 400
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS'])
const DIGIT_KEY = /^Digit[1-9]$/
const HIDDEN: IndexShortcutHints = { 'workspace.selectByIndex': false, 'tab.selectByIndex': false }

/** Which "select 1–9" shortcuts the held modifiers would fire with a digit, from the user's own bindings. */
export function heldIndexShortcutActions(
  held: HeldModifiers,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides | undefined
): IndexShortcutHints {
  // Copied field by field: a KeyboardEvent's modifier flags are prototype getters that a spread drops.
  const input = {
    key: '1',
    code: 'Digit1',
    metaKey: held.metaKey,
    ctrlKey: held.ctrlKey,
    altKey: held.altKey,
    shiftKey: held.shiftKey
  }
  const fires = (action: IndexShortcutAction): boolean =>
    matchKeybindingDigitIndex(action, input, platform, keybindings) !== null
  return {
    'workspace.selectByIndex': fires('workspace.selectByIndex'),
    'tab.selectByIndex': fires('tab.selectByIndex')
  }
}

const ACTIONS: readonly IndexShortcutAction[] = ['workspace.selectByIndex', 'tab.selectByIndex']
let shown: IndexShortcutHints = HIDDEN
// One timer per action: a shortcut whose modifiers become complete later still waits its own full hold.
const showTimers = new Map<IndexShortcutAction, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()
let unsubscribeModifierKeyUp: (() => void) | null = null

function publish(next: IndexShortcutHints): void {
  if (ACTIONS.every((action) => next[action] === shown[action])) {
    return
  }
  shown = next
  for (const listener of listeners) {
    listener()
  }
}

function cancelShow(action: IndexShortcutAction): void {
  const timer = showTimers.get(action)
  if (timer !== undefined) {
    clearTimeout(timer)
    showTimers.delete(action)
  }
}

function hide(): void {
  for (const action of ACTIONS) {
    cancelShow(action)
  }
  publish(HIDDEN)
}

function onModifiersChanged(event: KeyboardEvent): void {
  const held = heldIndexShortcutActions(
    event,
    getShortcutPlatform(),
    useAppStore.getState().keybindings
  )
  let next = shown
  for (const action of ACTIONS) {
    if (!held[action]) {
      cancelShow(action)
      next = { ...next, [action]: false }
    } else if (!next[action] && !showTimers.has(action)) {
      showTimers.set(
        action,
        setTimeout(() => {
          showTimers.delete(action)
          publish({ ...shown, [action]: true })
        }, SHOW_DELAY_MS)
      )
    }
  }
  publish(next)
}

function onKeyDown(event: KeyboardEvent): void {
  if (MODIFIER_KEYS.has(event.key)) {
    onModifiersChanged(event)
  } else if (!DIGIT_KEY.test(event.code)) {
    // Why digits keep the hints: the user is stepping through numbers with the modifier still held.
    hide()
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (MODIFIER_KEYS.has(event.key)) {
    onModifiersChanged(event)
  }
}

/** Hides the hints whose modifiers are no longer held; never shows any. */
function releaseUnheld(held: HeldModifiers): void {
  if (!ACTIONS.some((action) => shown[action] || showTimers.has(action))) {
    return
  }
  const stillHeld = heldIndexShortcutActions(
    held,
    getShortcutPlatform(),
    useAppStore.getState().keybindings
  )
  let next = shown
  for (const action of ACTIONS) {
    if (!stillHeld[action]) {
      cancelShow(action)
      next = { ...next, [action]: false }
    }
  }
  publish(next)
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') {
    hide()
  }
}

function attach(): void {
  // Capture: terminals and editors stop key events before they bubble to the window.
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('pointerdown', hide, true)
  window.addEventListener('pointermove', releaseUnheld, true)
  // Why: main consumes Cmd/Ctrl+digit, and macOS can then withhold the modifier's keyup from the page.
  unsubscribeModifierKeyUp = window.api.ui.onModifierKeyUp(releaseUnheld)
  window.addEventListener('blur', hide)
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function detach(): void {
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('keyup', onKeyUp, true)
  window.removeEventListener('pointerdown', hide, true)
  window.removeEventListener('pointermove', releaseUnheld, true)
  unsubscribeModifierKeyUp?.()
  unsubscribeModifierKeyUp = null
  window.removeEventListener('blur', hide)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  hide()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    attach()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      detach()
    }
  }
}

/** True while the user holds the modifiers of `action`'s binding, so rows can show the digit that reaches them. */
export function useIndexShortcutHintVisible(action: IndexShortcutAction): boolean {
  return useSyncExternalStore(subscribe, () => shown[action])
}
