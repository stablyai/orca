import { describe, expect, it, vi } from 'vitest'
import { getDiffViewerLargeDiffSaveAction } from './diff-viewer-large-diff-save-action'

describe('getDiffViewerLargeDiffSaveAction', () => {
  it('does not offer save when the displayed large-diff content was pruned', () => {
    const action = getDiffViewerLargeDiffSaveAction({
      editable: true,
      modifiedContent: '',
      onSave: vi.fn(),
      saveContentAvailable: false
    })

    expect(action).toBeUndefined()
  })

  it('can save an intentionally empty draft when content is available', () => {
    const onSave = vi.fn()
    const action = getDiffViewerLargeDiffSaveAction({
      editable: true,
      modifiedContent: '',
      onSave
    })

    action?.onClick()

    expect(onSave).toHaveBeenCalledWith('')
  })
})
