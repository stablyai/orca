import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeLinuxCandidateState,
  installTerminalImeLinuxCandidateState
} from './terminal-ime-linux-candidate-state'
import type { XtermBypassEvent } from './xterm-bypass-policy'

/** Creates a terminal keyboard event with default modifier state. */
function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('createTerminalImeLinuxCandidateState', () => {
  it('suppresses the next bare digit after an orphaned plain-letter keyup', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)

    const orphanLetterKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 })
    const orphanClassification = state.classifyKeyboardEvent(orphanLetterKeyup)
    expect(orphanClassification.candidateDigitGuardActive).toBe(false)
    state.observeKeyboardEvent(orphanLetterKeyup, orphanClassification)

    time += 10
    const digitKeydown = event({ key: '1', code: 'Digit1', keyCode: 49 })
    const digitKeydownClassification = state.classifyKeyboardEvent(digitKeydown)
    expect(digitKeydownClassification.candidateDigitGuardActive).toBe(true)
    state.observeKeyboardEvent(digitKeydown, digitKeydownClassification)

    const digitKeyup = event({ type: 'keyup', key: '1', code: 'Digit1', keyCode: 49 })
    const digitKeyupClassification = state.classifyKeyboardEvent(digitKeyup)
    expect(digitKeyupClassification.candidateDigitGuardActive).toBe(false)
    state.observeKeyboardEvent(digitKeyup, digitKeyupClassification)

    time += 10
    const secondDigit = event({ key: '2', code: 'Digit2', keyCode: 50 })
    expect(state.classifyKeyboardEvent(secondDigit).candidateDigitGuardActive).toBe(false)
  })

  it('does not suppress normal letter->digit typing when the letter had a matching keydown', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)

    const letterKeydown = event({ key: 'a', code: 'KeyA', keyCode: 65 })
    const letterKeydownClassification = state.classifyKeyboardEvent(letterKeydown)
    expect(letterKeydownClassification.candidateDigitGuardActive).toBe(false)
    state.observeKeyboardEvent(letterKeydown, letterKeydownClassification)

    time += 10
    const letterKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 })
    const letterKeyupClassification = state.classifyKeyboardEvent(letterKeyup)
    expect(letterKeyupClassification.candidateDigitGuardActive).toBe(false)
    state.observeKeyboardEvent(letterKeyup, letterKeyupClassification)

    time += 10
    const digitKeydown = event({ key: '1', code: 'Digit1', keyCode: 49 })
    expect(state.classifyKeyboardEvent(digitKeydown).candidateDigitGuardActive).toBe(false)
  })

  it('does not mistake a long-held letter release for an orphaned keyup', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)

    const letterKeydown = event({ key: 'a', code: 'KeyA', keyCode: 65 })
    const letterKeydownClassification = state.classifyKeyboardEvent(letterKeydown)
    state.observeKeyboardEvent(letterKeydown, letterKeydownClassification)

    time += 2_000
    const letterKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 })
    const letterKeyupClassification = state.classifyKeyboardEvent(letterKeyup)
    state.observeKeyboardEvent(letterKeyup, letterKeyupClassification)

    time += 10
    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1', keyCode: 49 }))
        .candidateDigitGuardActive
    ).toBe(false)
  })

  it('clears a pending physical key when modifiers change before release', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)
    const letterKeydown = event({ key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(letterKeydown, state.classifyKeyboardEvent(letterKeydown))
    const modifiedKeyup = event({
      type: 'keyup',
      key: 'A',
      code: 'KeyA',
      shiftKey: true
    })
    state.observeKeyboardEvent(modifiedKeyup, state.classifyKeyboardEvent(modifiedKeyup))

    time += 10
    const orphanKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(orphanKeyup, state.classifyKeyboardEvent(orphanKeyup))
    time += 10
    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' })).candidateDigitGuardActive
    ).toBe(true)
  })

  it('does not mistake a shifted physical letter for an orphan after Shift releases first', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)
    for (const keyboardEvent of [
      event({ key: 'A', code: 'KeyA', shiftKey: true }),
      event({ type: 'keyup', key: 'Shift', code: 'ShiftLeft' }),
      event({ type: 'keyup', key: 'a', code: 'KeyA' })
    ]) {
      state.observeKeyboardEvent(keyboardEvent, state.classifyKeyboardEvent(keyboardEvent))
      time += 10
    }

    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' })).candidateDigitGuardActive
    ).toBe(false)
  })

  it('cancels the orphan guard when another non-digit keydown intervenes', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)
    for (const keyboardEvent of [
      event({ type: 'keyup', key: 'a', code: 'KeyA' }),
      event({ key: 'b', code: 'KeyB' }),
      event({ type: 'keyup', key: 'b', code: 'KeyB' })
    ]) {
      state.observeKeyboardEvent(keyboardEvent, state.classifyKeyboardEvent(keyboardEvent))
      time += 10
    }

    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' })).candidateDigitGuardActive
    ).toBe(false)
  })

  it('resets missed releases on blur and removes the listener on dispose', () => {
    let time = 100
    const terminalElement = new EventTarget()
    const removeEventListener = vi.spyOn(terminalElement, 'removeEventListener')
    const state = installTerminalImeLinuxCandidateState(terminalElement, () => time)
    const letterKeydown = event({ key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(letterKeydown, state.classifyKeyboardEvent(letterKeydown))

    terminalElement.dispatchEvent(new Event('blur'))
    time += 10
    const orphanKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(orphanKeyup, state.classifyKeyboardEvent(orphanKeyup))
    time += 10
    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' })).candidateDigitGuardActive
    ).toBe(true)

    state.dispose()
    expect(removeEventListener).toHaveBeenCalledWith('blur', state.resetCandidateGuard, true)
  })

  it('shares pressed letters across pane focus handoffs and disposes the tracker once', () => {
    let time = 100
    const rendererWindow = new EventTarget()
    const removeWindowListener = vi.spyOn(rendererWindow, 'removeEventListener')
    const firstTerminal = new EventTarget()
    const secondTerminal = new EventTarget()
    const firstState = installTerminalImeLinuxCandidateState(
      firstTerminal,
      () => time,
      rendererWindow
    )
    const secondState = installTerminalImeLinuxCandidateState(
      secondTerminal,
      () => time,
      rendererWindow
    )

    const letterKeydown = event({ key: 'a', code: 'KeyA' })
    firstState.observeKeyboardEvent(letterKeydown, firstState.classifyKeyboardEvent(letterKeydown))
    firstTerminal.dispatchEvent(new Event('blur'))
    const letterKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA' })
    secondState.observeKeyboardEvent(letterKeyup, secondState.classifyKeyboardEvent(letterKeyup))
    time += 10
    expect(
      secondState.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' }))
        .candidateDigitGuardActive
    ).toBe(false)

    firstState.dispose()
    expect(removeWindowListener).not.toHaveBeenCalled()
    secondState.dispose()
    expect(removeWindowListener).toHaveBeenCalledWith('keyup', expect.any(Function))
  })

  it('clears renderer-wide pressed letters when the window blurs', () => {
    let time = 100
    const rendererWindow = new EventTarget()
    const state = installTerminalImeLinuxCandidateState(
      new EventTarget(),
      () => time,
      rendererWindow
    )
    const letterKeydown = event({ key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(letterKeydown, state.classifyKeyboardEvent(letterKeydown))

    rendererWindow.dispatchEvent(new Event('blur'))
    const orphanKeyup = event({ type: 'keyup', key: 'a', code: 'KeyA' })
    state.observeKeyboardEvent(orphanKeyup, state.classifyKeyboardEvent(orphanKeyup))
    time += 10
    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1' })).candidateDigitGuardActive
    ).toBe(true)
    state.dispose()
  })

  it('does not suppress a digit after overlapping ordinary letter key presses', () => {
    let time = 100
    const state = createTerminalImeLinuxCandidateState(() => time)

    for (const keyboardEvent of [
      event({ key: 'a', code: 'KeyA', keyCode: 65 }),
      event({ key: 'b', code: 'KeyB', keyCode: 66 }),
      event({ type: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 }),
      event({ type: 'keyup', key: 'b', code: 'KeyB', keyCode: 66 })
    ]) {
      const classification = state.classifyKeyboardEvent(keyboardEvent)
      state.observeKeyboardEvent(keyboardEvent, classification)
      time += 10
    }

    expect(
      state.classifyKeyboardEvent(event({ key: '1', code: 'Digit1', keyCode: 49 }))
        .candidateDigitGuardActive
    ).toBe(false)
  })
})
