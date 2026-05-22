import { useSyncExternalStore } from 'react'

type OptionKeyListener = () => void

let optionPressed = false
const listeners = new Set<OptionKeyListener>()
let disposeWindowListeners: (() => void) | null = null

function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

function setOptionPressed(nextPressed: boolean): void {
  if (optionPressed === nextPressed) {
    return
  }
  optionPressed = nextPressed
  for (const listener of listeners) {
    listener()
  }
}

function startWindowListeners(): void {
  if (disposeWindowListeners || !isMacPlatform() || typeof window === 'undefined') {
    return
  }

  const handleKeyChange = (event: KeyboardEvent): void => setOptionPressed(event.altKey)
  const handleWindowBlur = (): void => setOptionPressed(false)
  window.addEventListener('keydown', handleKeyChange, true)
  window.addEventListener('keyup', handleKeyChange, true)
  window.addEventListener('blur', handleWindowBlur)
  disposeWindowListeners = () => {
    window.removeEventListener('keydown', handleKeyChange, true)
    window.removeEventListener('keyup', handleKeyChange, true)
    window.removeEventListener('blur', handleWindowBlur)
  }
}

export function subscribeMacOptionKey(listener: OptionKeyListener): () => void {
  if (!isMacPlatform()) {
    return () => undefined
  }
  listeners.add(listener)
  startWindowListeners()
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) {
      return
    }
    disposeWindowListeners?.()
    disposeWindowListeners = null
    setOptionPressed(false)
  }
}

export function getMacOptionKeySnapshot(): boolean {
  return isMacPlatform() ? optionPressed : false
}

export function useMacOptionKeyPressed(): boolean {
  // Why: the sidebar can render dozens of cards. One shared external store
  // avoids a global key listener per card and only re-renders on Option flips.
  return useSyncExternalStore(subscribeMacOptionKey, getMacOptionKeySnapshot, () => false)
}
