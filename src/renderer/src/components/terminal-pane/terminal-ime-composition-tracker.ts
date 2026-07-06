import type { IDisposable } from '@xterm/xterm'

export type TerminalImeCompositionTracker = IDisposable & {
  isActive: () => boolean
  hasCjkCompositionText: () => boolean
}

const CJK_COMPOSITION_TEXT_PATTERN =
  /[\u1100-\u11ff\u2e80-\u30ff\u3100-\u318f\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

export function hasCjkCompositionText(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && CJK_COMPOSITION_TEXT_PATTERN.test(text)
}

function readCompositionEventData(event: Event): string | null {
  const data = (event as { data?: unknown }).data
  return typeof data === 'string' ? data : null
}

export function installTerminalImeCompositionTracker(
  terminalElement: HTMLElement | null | undefined
): TerminalImeCompositionTracker {
  let active = false
  let cjkCompositionText = false
  if (!terminalElement) {
    return {
      isActive: () => active,
      hasCjkCompositionText: () => cjkCompositionText,
      dispose: () => undefined
    }
  }

  const markActive = (): void => {
    active = true
    cjkCompositionText = false
  }
  const updateComposition = (event: Event): void => {
    const data = readCompositionEventData(event)
    if (data === null) {
      active = true
      cjkCompositionText = false
      return
    }
    active = data !== ''
    cjkCompositionText = hasCjkCompositionText(data)
  }
  const handleInput = (event: Event): void => {
    if (event instanceof InputEvent && event.inputType === 'insertCompositionText') {
      cjkCompositionText = hasCjkCompositionText(event.data)
      return
    }
    active = false
    cjkCompositionText = false
  }
  const markInactive = (): void => {
    active = false
    cjkCompositionText = false
  }

  terminalElement.addEventListener('compositionstart', markActive, true)
  terminalElement.addEventListener('compositionupdate', updateComposition, true)
  terminalElement.addEventListener('compositionend', markInactive, true)
  terminalElement.addEventListener('input', handleInput, true)
  terminalElement.addEventListener('blur', markInactive, true)

  return {
    isActive: () => active,
    hasCjkCompositionText: () => active && cjkCompositionText,
    dispose: () => {
      terminalElement.removeEventListener('compositionstart', markActive, true)
      terminalElement.removeEventListener('compositionupdate', updateComposition, true)
      terminalElement.removeEventListener('compositionend', markInactive, true)
      terminalElement.removeEventListener('input', handleInput, true)
      terminalElement.removeEventListener('blur', markInactive, true)
    }
  }
}
