import { describe, expect, it } from 'vitest'
import { createTerminalImeLinuxCandidateState } from './terminal-ime-linux-candidate-state'
import type { XtermBypassEvent } from './xterm-bypass-policy'

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
})
