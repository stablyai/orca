import { describe, expect, it, vi } from 'vitest'
import { runEditorPopoutSave, type EditorPopoutSaveSlot } from './editor-popout-save-coordinator'

describe('runEditorPopoutSave', () => {
  it('reuses an in-flight save and permits the next save after it settles', async () => {
    let finishFirst: ((saved: boolean) => void) | undefined
    const firstResult = new Promise<boolean>((resolve) => {
      finishFirst = resolve
    })
    const task = vi.fn().mockReturnValueOnce(firstResult).mockResolvedValueOnce(true)
    const slot: EditorPopoutSaveSlot = { current: null }

    const first = runEditorPopoutSave(slot, task)
    const concurrent = runEditorPopoutSave(slot, task)

    expect(concurrent).toBe(first)
    expect(task).toHaveBeenCalledOnce()

    finishFirst?.(true)
    await first
    const next = runEditorPopoutSave(slot, task)

    await expect(next).resolves.toBe(true)
    expect(task).toHaveBeenCalledTimes(2)
  })
})
