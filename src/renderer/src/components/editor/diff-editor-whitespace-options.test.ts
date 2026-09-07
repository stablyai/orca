import { describe, expect, it } from 'vitest'
import { buildDiffEditorWhitespaceOptions } from './diff-editor-whitespace-options'

describe('buildDiffEditorWhitespaceOptions', () => {
  it('ignores trim whitespace by default', () => {
    expect(buildDiffEditorWhitespaceOptions(undefined)).toEqual({ ignoreTrimWhitespace: true })
    expect(buildDiffEditorWhitespaceOptions(false)).toEqual({ ignoreTrimWhitespace: true })
  })

  it('includes whitespace in the diff when the preference is on', () => {
    expect(buildDiffEditorWhitespaceOptions(true)).toEqual({ ignoreTrimWhitespace: false })
  })
})
