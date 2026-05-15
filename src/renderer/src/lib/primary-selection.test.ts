import { beforeEach, describe, expect, it } from 'vitest'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  getPrimarySelectionText,
  resetPrimarySelectionForTests,
  setPrimarySelectionEnabled,
  setPrimarySelectionText
} from './primary-selection'

describe('primary selection buffer', () => {
  beforeEach(() => {
    resetPrimarySelectionForTests()
  })

  it('ignores writes while disabled', () => {
    expect(setPrimarySelectionText('hello')).toBe(false)
    expect(getPrimarySelectionText()).toBe('')
  })

  it('stores selected text while enabled', () => {
    setPrimarySelectionEnabled(true)

    expect(setPrimarySelectionText('hello')).toBe(true)
    expect(getPrimarySelectionText()).toBe('hello')
  })

  it('keeps the current buffer when a selection is empty or too large', () => {
    setPrimarySelectionEnabled(true)
    setPrimarySelectionText('current')

    expect(setPrimarySelectionText('')).toBe(false)
    expect(getPrimarySelectionText()).toBe('current')

    expect(setPrimarySelectionText('x'.repeat(PRIMARY_SELECTION_MAX_LENGTH + 1))).toBe(false)
    expect(getPrimarySelectionText()).toBe('current')
  })

  it('clears the buffer when disabled', () => {
    setPrimarySelectionEnabled(true)
    setPrimarySelectionText('hello')

    setPrimarySelectionEnabled(false)

    expect(getPrimarySelectionText()).toBe('')
  })
})
