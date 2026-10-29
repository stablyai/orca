import { afterEach, describe, expect, it, vi } from 'vitest'

const restart = vi.hoisted(() => ({ intentional: false }))
vi.mock('@/lib/updater-beforeunload', () => ({
  isIntentionalAppRestartInProgress: () => restart.intentional
}))

import { confirmQuitDuringWslMove } from './use-wsl-move-quit-guard'

describe('quitting during a WSL move', () => {
  it('asks while a move runs, and quits only when the user confirms', async () => {
    const confirm = vi.fn(async () => false)
    expect(await confirmQuitDuringWslMove(async () => true, confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'A project is moving to its WSL host. Quit anyway? The move will be undone at next launch.',
        confirmLabel: 'Quit anyway'
      })
    )
    confirm.mockResolvedValueOnce(true)
    expect(await confirmQuitDuringWslMove(async () => true, confirm)).toBe(true)
  })

  it('quits without asking when no move runs, or when main cannot say', async () => {
    const confirm = vi.fn(async () => false)
    expect(await confirmQuitDuringWslMove(async () => false, confirm)).toBe(true)
    expect(
      await confirmQuitDuringWslMove(async () => {
        throw new Error('ipc gone')
      }, confirm)
    ).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('never asks during an intentional restart', async () => {
    restart.intentional = true
    const confirm = vi.fn(async () => false)
    expect(await confirmQuitDuringWslMove(async () => true, confirm)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    restart.intentional = false
  })

  describe('when main does not answer', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('quits without asking after 2 s rather than wait forever', async () => {
      vi.useFakeTimers()
      const confirm = vi.fn(async () => false)
      const settled = vi.fn()
      void confirmQuitDuringWslMove(() => new Promise<boolean>(() => {}), confirm).then(settled)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toHaveBeenCalledWith(true)
      expect(confirm).not.toHaveBeenCalled()
    })
  })
})
