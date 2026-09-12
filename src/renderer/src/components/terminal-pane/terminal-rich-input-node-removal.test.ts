import { describe, expect, it, vi } from 'vitest'
import { removeTerminalRichInputNode } from './terminal-rich-input-node-removal'

describe('removeTerminalRichInputNode', () => {
  it('restores editor focus at the removed atom position', () => {
    const deleteNode = vi.fn()
    const focusEditor = vi.fn()
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })

    removeTerminalRichInputNode({
      deleteNode,
      focusEditor,
      getPosition: () => 7,
      schedule
    })

    expect(deleteNode).toHaveBeenCalledOnce()
    expect(focusEditor).toHaveBeenCalledWith(7)
  })

  it('uses a position-aware delete when the atom owns adjacent editor content', () => {
    const deleteNode = vi.fn()
    const deleteAtPosition = vi.fn().mockReturnValue(true)
    const focusEditor = vi.fn()

    removeTerminalRichInputNode({
      deleteNode,
      deleteAtPosition,
      focusEditor,
      getPosition: () => 7,
      schedule: (callback) => {
        callback(0)
        return 1
      }
    })

    expect(deleteAtPosition).toHaveBeenCalledWith(7)
    expect(deleteNode).not.toHaveBeenCalled()
    expect(focusEditor).toHaveBeenCalledWith(7)
  })
})
