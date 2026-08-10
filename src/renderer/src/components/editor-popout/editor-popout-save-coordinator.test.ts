import { describe, expect, it, vi } from 'vitest'
import {
  canCloseEditorPopoutAfterSave,
  isEditorPopoutContentDirty,
  runEditorPopoutSave,
  type EditorPopoutSaveSlot
} from './editor-popout-save-coordinator'

describe('runEditorPopoutSave', () => {
  it('treats trailing whitespace changes as unsaved content', () => {
    expect(isEditorPopoutContentDirty('# Note\n\n', '# Note\n')).toBe(true)
    expect(isEditorPopoutContentDirty('# Note\n', '# Note\n')).toBe(false)
  })

  it('keeps the window open when content changes during save', () => {
    expect(canCloseEditorPopoutAfterSave(true, '# Saving\n', '# Newer\n')).toBe(false)
    expect(canCloseEditorPopoutAfterSave(true, '# Saving\n', '# Saving\n')).toBe(true)
    expect(canCloseEditorPopoutAfterSave(false, '# Saving\n', '# Saving\n')).toBe(false)
  })

  it('serializes a newer save behind an in-flight save', async () => {
    let finishFirst: ((saved: boolean) => void) | undefined
    const firstResult = new Promise<boolean>((resolve) => {
      finishFirst = resolve
    })
    const task = vi.fn().mockReturnValueOnce(firstResult).mockResolvedValueOnce(true)
    const slot: EditorPopoutSaveSlot = { current: null }

    const first = runEditorPopoutSave(slot, task)
    const concurrent = runEditorPopoutSave(slot, task)

    expect(task).toHaveBeenCalledOnce()

    finishFirst?.(true)
    await first
    await expect(concurrent).resolves.toBe(true)
    expect(task).toHaveBeenCalledTimes(2)
    expect(slot.current).toBeNull()
  })
})
