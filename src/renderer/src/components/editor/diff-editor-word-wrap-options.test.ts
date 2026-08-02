import { describe, expect, it } from 'vitest'
import { buildDiffEditorWordWrapOptions } from './diff-editor-word-wrap-options'

describe('buildDiffEditorWordWrapOptions', () => {
  it('keeps long diff lines unwrapped by default', () => {
    expect(buildDiffEditorWordWrapOptions(undefined)).toEqual({ wordWrap: 'off' })
    expect(buildDiffEditorWordWrapOptions(false)).toEqual({ wordWrap: 'off' })
  })

  it('enables Monaco diff word wrapping when the diff preference is on', () => {
    expect(buildDiffEditorWordWrapOptions(true)).toEqual({ wordWrap: 'on' })
  })
})
