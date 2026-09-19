import { describe, expect, it } from 'vitest'
import { resolveDiffRenderSideBySide, shouldForceInlineDiff } from './diff-added-file-inline-mode'
import { buildDiffEditorLineNumberOptions } from './diff-editor-line-number-options'

describe('shouldForceInlineDiff', () => {
  it('treats a created file as inline-only', () => {
    expect(shouldForceInlineDiff({ originalContent: '', modifiedContent: 'new file\n' })).toBe(true)
  })

  it('keeps two real sides two-sided', () => {
    // A rename with edits has a real original, so it stays a modification.
    expect(shouldForceInlineDiff({ originalContent: 'was\n', modifiedContent: 'is\n' })).toBe(false)
  })

  it('leaves a deletion alone', () => {
    // The mirror case is a deliberate non-goal: deletions are read far less
    // often, and changing them is a separate decision.
    expect(shouldForceInlineDiff({ originalContent: 'gone\n', modifiedContent: '' })).toBe(false)
  })

  it('does not fire when neither side has content', () => {
    expect(shouldForceInlineDiff({ originalContent: '', modifiedContent: '' })).toBe(false)
  })
})

describe('resolveDiffRenderSideBySide', () => {
  it('overrides Side by Side only for created files', () => {
    const created = { originalContent: '', modifiedContent: 'new\n' }
    const modified = { originalContent: 'a\n', modifiedContent: 'b\n' }

    expect(resolveDiffRenderSideBySide(true, created)).toBe(false)
    expect(resolveDiffRenderSideBySide(true, modified)).toBe(true)
  })

  it('changes nothing while the toolbar is set to Inline', () => {
    expect(
      resolveDiffRenderSideBySide(false, { originalContent: '', modifiedContent: 'new\n' })
    ).toBe(false)
    expect(
      resolveDiffRenderSideBySide(false, { originalContent: 'a\n', modifiedContent: 'b\n' })
    ).toBe(false)
  })
})

describe('created-file inline mode at its call sites', () => {
  const addedImage = { originalContent: '', modifiedContent: 'data:image/png;base64,AAAA' }

  // Why: ImageDiffViewer picks grid-cols-2 straight off this flag, so an added
  // image resolved from the raw setting draws an empty Original pane.
  it('collapses an added image preview to one column', () => {
    expect(resolveDiffRenderSideBySide(true, addedImage)).toBe(false)
  })

  // Why: the gutter policy reads the effective mode, not the toolbar. Fed the
  // raw setting, a created file keeps a duplicate original gutter inline.
  it('turns the original gutter off for a created file', () => {
    const created = { originalContent: '', modifiedContent: 'new\n' }

    expect(buildDiffEditorLineNumberOptions(resolveDiffRenderSideBySide(true, created))).toEqual({
      original: 'off',
      modified: 'on'
    })
    expect(
      buildDiffEditorLineNumberOptions(
        resolveDiffRenderSideBySide(true, { originalContent: 'a\n', modifiedContent: 'b\n' })
      )
    ).toEqual({ original: 'on', modified: 'on' })
  })
})
