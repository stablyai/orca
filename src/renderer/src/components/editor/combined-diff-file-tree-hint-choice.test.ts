import { describe, expect, it, vi } from 'vitest'
import { applyCombinedDiffFileTreeHintChoice } from './combined-diff-file-tree-hint-choice'

function harness() {
  return {
    updateSettings: vi.fn(),
    setFileTreeCollapsed: vi.fn(),
    dismissHint: vi.fn()
  }
}

describe('applyCombinedDiffFileTreeHintChoice', () => {
  it('saves the shown default, opens the tree, and closes the hint', () => {
    const calls = harness()

    applyCombinedDiffFileTreeHintChoice({ choice: 'shown', ...calls })

    expect(calls.updateSettings).toHaveBeenCalledWith({
      combinedDiffFileTreeVisibleByDefault: true
    })
    expect(calls.setFileTreeCollapsed).toHaveBeenCalledWith(false)
    expect(calls.dismissHint).toHaveBeenCalledTimes(1)
  })

  it('saves the hidden default without pinning the session tree override', () => {
    const calls = harness()

    applyCombinedDiffFileTreeHintChoice({ choice: 'hidden', ...calls })

    expect(calls.updateSettings).toHaveBeenCalledWith({
      combinedDiffFileTreeVisibleByDefault: false
    })
    expect(calls.setFileTreeCollapsed).not.toHaveBeenCalled()
    expect(calls.dismissHint).toHaveBeenCalledTimes(1)
  })
})
