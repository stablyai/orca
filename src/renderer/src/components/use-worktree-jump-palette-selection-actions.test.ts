import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  showClientCreationActionError: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/client-creation-action-error', () => ({
  showClientCreationActionError: mocks.showClientCreationActionError
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { showQuickActionRunError } from './use-worktree-jump-palette-selection-actions'

describe('showQuickActionRunError', () => {
  beforeEach(() => {
    mocks.showClientCreationActionError.mockReset()
    mocks.toastError.mockReset()
  })

  it('surfaces a rejected terminal action through the shared client-action presenter', () => {
    const error = new Error('runtime disconnected')

    showQuickActionRunError('new-terminal-tab', error)

    expect(mocks.showClientCreationActionError).toHaveBeenCalledWith(error)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('preserves the plugin-specific failure message', () => {
    showQuickActionRunError('plugin:example', new Error('plugin failed'))

    expect(mocks.showClientCreationActionError).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('Could not run the plugin command.')
  })
})
