import { describe, expect, it } from 'vitest'
import { buildFileEditorWordWrapOptions } from './file-editor-word-wrap-options'

describe('buildFileEditorWordWrapOptions', () => {
  it('keeps wrapping enabled for existing profiles without the preference', () => {
    expect(buildFileEditorWordWrapOptions(undefined)).toEqual({ wordWrap: 'on' })
    expect(buildFileEditorWordWrapOptions(true)).toEqual({ wordWrap: 'on' })
  })

  it('disables wrapping for horizontal file-editor scrolling', () => {
    expect(buildFileEditorWordWrapOptions(false)).toEqual({ wordWrap: 'off' })
  })
})
