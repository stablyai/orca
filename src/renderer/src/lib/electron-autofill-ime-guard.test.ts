// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOFILL_IME_GUARD_SENTINEL,
  installElectronAutofillImeGuard,
  resolveAutofillGuardableField,
  type ElectronAutofillImeGuard
} from './electron-autofill-ime-guard'

const SENT = AUTOFILL_IME_GUARD_SENTINEL

function imeProcessKeydown(target: HTMLElement): void {
  const event = new KeyboardEvent('keydown', { key: 'Process', bubbles: true })
  // Why: KeyboardEvent constructors ignore legacy keyCode; real IME keydowns
  // carry 229 and the guard accepts either signal.
  Object.defineProperty(event, 'keyCode', { value: 229 })
  target.dispatchEvent(event)
}

function composition(target: HTMLElement, type: 'compositionstart' | 'compositionend'): void {
  // Why: happy-dom lacks CompositionEvent; a plain bubbling Event carries the
  // same target/type surface the guard reads.
  target.dispatchEvent(new Event(type, { bubbles: true }))
}

describe('resolveAutofillGuardableField', () => {
  it('accepts plain text inputs and textareas', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    expect(resolveAutofillGuardableField(input)).toBe(input)
    expect(resolveAutofillGuardableField(textarea)).toBe(textarea)
  })

  it('rejects Monaco textareas, readonly, disabled, and non-text inputs', () => {
    const monaco = document.createElement('textarea')
    monaco.classList.add('inputarea')
    expect(resolveAutofillGuardableField(monaco)).toBeNull()

    const readonly = document.createElement('textarea')
    readonly.readOnly = true
    expect(resolveAutofillGuardableField(readonly)).toBeNull()

    const disabled = document.createElement('input')
    disabled.disabled = true
    expect(resolveAutofillGuardableField(disabled)).toBeNull()

    const password = document.createElement('input')
    password.type = 'password'
    expect(resolveAutofillGuardableField(password)).toBeNull()

    expect(resolveAutofillGuardableField(document.createElement('div'))).toBeNull()
    expect(resolveAutofillGuardableField(null)).toBeNull()
  })
})

describe('installElectronAutofillImeGuard', () => {
  let guard: ElectronAutofillImeGuard
  let input: HTMLInputElement

  beforeEach(() => {
    vi.useFakeTimers()
    input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    guard = installElectronAutofillImeGuard(document)
  })

  afterEach(() => {
    guard.dispose()
    input.remove()
    vi.useRealTimers()
  })

  it('arms on an IME process keydown, keeping the caret before the sentinel', () => {
    input.value = 'ab'
    input.setSelectionRange(2, 2)

    imeProcessKeydown(input)

    expect(input.value).toBe(`ab${SENT}`)
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('does not arm on plain keydowns, so ASCII typing never sees the sentinel', () => {
    input.value = 'ab'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(input.value).toBe('ab')
  })

  it('does not double-arm across repeated process keydowns', () => {
    imeProcessKeydown(input)
    imeProcessKeydown(input)
    expect(input.value).toBe(SENT)
  })

  it('does not arm while a composition is active', () => {
    imeProcessKeydown(input)
    composition(input, 'compositionstart')
    // xterm and Orca forwarders can clear the field mid-composition.
    input.value = 'preedit'
    imeProcessKeydown(input)
    expect(input.value).toBe('preedit')
  })

  it('strips after compositionend and emits an input event for React state sync', () => {
    const inputEvents: string[] = []
    input.addEventListener('input', () => inputEvents.push(input.value))

    imeProcessKeydown(input)
    composition(input, 'compositionstart')
    input.value = `にほんご${SENT}`
    input.setSelectionRange(4, 4)
    composition(input, 'compositionend')
    vi.runAllTimers()

    expect(input.value).toBe('にほんご')
    expect(input.selectionStart).toBe(4)
    expect(inputEvents).toContain('にほんご')
  })

  it('keeps the sentinel when a new composition starts before the strip timer runs', () => {
    imeProcessKeydown(input)
    composition(input, 'compositionstart')
    input.value = `あ${SENT}`
    composition(input, 'compositionend')
    composition(input, 'compositionstart')
    vi.runAllTimers()

    expect(input.value).toBe(`あ${SENT}`)
  })

  it('clears a leftover sentinel from IME direct commits via the input path', () => {
    imeProcessKeydown(input)
    // Direct commit (e.g. 、) inserts text without composition events.
    input.value = `、${SENT}`
    input.dispatchEvent(new Event('input', { bubbles: true }))
    vi.runAllTimers()

    expect(input.value).toBe('、')
  })

  it('strips immediately on focusout', () => {
    imeProcessKeydown(input)
    expect(input.value).toBe(SENT)

    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))

    expect(input.value).toBe('')
  })

  it('leaves Monaco textareas untouched', () => {
    const monaco = document.createElement('textarea')
    monaco.classList.add('inputarea')
    document.body.appendChild(monaco)

    imeProcessKeydown(monaco)

    expect(monaco.value).toBe('')
    monaco.remove()
  })

  it('stops acting after dispose', () => {
    guard.dispose()
    imeProcessKeydown(input)
    expect(input.value).toBe('')
    // Re-install so afterEach dispose stays balanced.
    guard = installElectronAutofillImeGuard(document)
  })
})
