import { describe, expect, it } from 'vitest'
import { monacoFindOptions } from './monaco-find-options'

describe('monacoFindOptions', () => {
  it('seeds Find only from an explicit selection without changing its layout or scope', () => {
    expect(monacoFindOptions).toEqual({
      addExtraSpaceOnTop: false,
      autoFindInSelection: 'never',
      seedSearchStringFromSelection: 'selection'
    })
  })
})
