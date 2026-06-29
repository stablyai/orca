import type { IDisposable } from '@xterm/xterm'

export type TerminalImeCompositionTracker = IDisposable & {
  isActive: () => boolean
}

export function installTerminalImeCompositionTracker(
  terminalElement: HTMLElement | null | undefined
): TerminalImeCompositionTracker {
  let active = false
  if (!terminalElement) {
    return {
      isActive: () => active,
      dispose: () => undefined
    }
  }

  const markActive = (): void => {
    active = true
  }
  const updateComposition = (event: Event): void => {
    active = !(event instanceof CompositionEvent) || event.data !== ''
  }
  const handleInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      return
    }
    active = false
  }
  const markInactive = (): void => {
    active = false
  }

  terminalElement.addEventListener('compositionstart', markActive, true)
  terminalElement.addEventListener('compositionupdate', updateComposition, true)
  terminalElement.addEventListener('compositionend', markInactive, true)
  terminalElement.addEventListener('input', handleInput, true)
  terminalElement.addEventListener('blur', markInactive, true)

  return {
    isActive: () => active,
    dispose: () => {
      terminalElement.removeEventListener('compositionstart', markActive, true)
      terminalElement.removeEventListener('compositionupdate', updateComposition, true)
      terminalElement.removeEventListener('compositionend', markInactive, true)
      terminalElement.removeEventListener('input', handleInput, true)
      terminalElement.removeEventListener('blur', markInactive, true)
    }
  }
}
