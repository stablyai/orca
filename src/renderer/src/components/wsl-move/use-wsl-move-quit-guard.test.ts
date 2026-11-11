import { describe, expect, it, vi } from 'vitest'

const restart = vi.hoisted(() => ({ intentional: false }))
vi.mock('@/app-shell/updates/updater-beforeunload', () => ({
  isIntentionalAppRestartInProgress: () => restart.intentional
}))

import { confirmQuitDuringWslMove } from './use-wsl-move-quit-guard'

describe('quitting during a WSL move', () => {
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
})
