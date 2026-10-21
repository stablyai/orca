import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  state: {
    machineProviders: { 'plugin:o/omarchy': { name: 'Omarchy', capabilities: undefined } },
    activeWorktreeId: null,
    closeModal: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))

import { signInToMachineProvider } from './machine-provider-actions'

beforeEach(() => vi.clearAllMocks())

describe('signInToMachineProvider', () => {
  it('leaves a way back to the composer it closed', () => {
    const reopen = vi.fn()
    signInToMachineProvider('plugin:o/omarchy', reopen)

    expect(mocks.state.closeModal).toHaveBeenCalled()
    const [message, options] = mocks.toast.mock.calls[0]
    expect(message).toBe('Finish signing in to Omarchy, then go back to your new worktree.')
    options.action.onClick()
    expect(reopen).toHaveBeenCalled()
  })

  it('shows no way back when nothing was closed for it', () => {
    signInToMachineProvider('plugin:o/omarchy')
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
