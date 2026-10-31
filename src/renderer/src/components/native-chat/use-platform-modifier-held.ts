import { useSyncExternalStore } from 'react'

type Listener = () => void
type HeldModifier = 'metaKey' | 'ctrlKey'

// One window listener set for every mounted chat, so a keystroke costs the same with one chat or many.
const listeners = new Set<Listener>()
let held: Record<HeldModifier, boolean> = { metaKey: false, ctrlKey: false }

function publish(next: Record<HeldModifier, boolean>): void {
  if (next.metaKey === held.metaKey && next.ctrlKey === held.ctrlKey) {
    return
  }
  held = next
  for (const listener of listeners) {
    listener()
  }
}

/** The modifier this key is, null for a modifier that isn't tracked, undefined for any other key. */
function modifierOfKey(key: string): HeldModifier | null | undefined {
  switch (key) {
    case 'Meta':
    case 'OS':
    case 'Command':
      return 'metaKey'
    case 'Control':
      return 'ctrlKey'
    case 'Alt':
    case 'Option':
    case 'Shift':
      return null
    default:
      return undefined
  }
}

function readKeyboardEvent(event: KeyboardEvent): void {
  const modifier = modifierOfKey(event.key)
  if (modifier) {
    publish({ ...held, [modifier]: event.type === 'keydown' })
  } else if (modifier === undefined) {
    // Other keys can only clear: dictation's paste leaves metaKey set on later events until a real Meta press,
    // and a keyup swallowed elsewhere still clears on the next key.
    publish({ metaKey: held.metaKey && event.metaKey, ctrlKey: held.ctrlKey && event.ctrlKey })
  }
}

// Dictation tools can paste without the modifier's keyup, and a blurred window never sees one.
function release(): void {
  publish({ metaKey: false, ctrlKey: false })
}

function subscribeModifierHeld(listener: Listener): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', readKeyboardEvent, true)
    window.addEventListener('keyup', readKeyboardEvent, true)
    window.addEventListener('paste', release, true)
    window.addEventListener('blur', release)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) {
      return
    }
    window.removeEventListener('keydown', readKeyboardEvent, true)
    window.removeEventListener('keyup', readKeyboardEvent, true)
    window.removeEventListener('paste', release, true)
    window.removeEventListener('blur', release)
    // Unwatched, the state would go stale; the next subscriber starts from released.
    held = { metaKey: false, ctrlKey: false }
  }
}

function subscribeNothing(): () => void {
  return () => {}
}

const getMetaHeld = (): boolean => held.metaKey
const getCtrlHeld = (): boolean => held.ctrlKey

/** Whether Cmd (Mac) or Ctrl (elsewhere) is held now, so a control can show what a modified click does. */
export function usePlatformModifierHeld(enabled: boolean, isMac: boolean): boolean {
  const modifierHeld = useSyncExternalStore(
    enabled ? subscribeModifierHeld : subscribeNothing,
    isMac ? getMetaHeld : getCtrlHeld
  )
  return enabled && modifierHeld
}
