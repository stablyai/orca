import { beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

import { announcePluginAutoUpdates } from './plugin-auto-updates'

beforeEach(() => toastMocks.success.mockReset())

describe('plugin auto-update toast', () => {
  it('shows nothing for an empty pass and one batched toast for several plugins', () => {
    announcePluginAutoUpdates([])
    expect(toastMocks.success).not.toHaveBeenCalled()
    announcePluginAutoUpdates([{ pluginKey: 'a.one', name: 'One', version: '1.1.0' }])
    expect(toastMocks.success).toHaveBeenLastCalledWith('One updated to 1.1.0')
    announcePluginAutoUpdates([
      { pluginKey: 'a.one', name: 'One', version: '1.1.0' },
      { pluginKey: 'a.two', name: 'Two', version: '2.0.0' },
      { pluginKey: 'a.three', name: 'Three', version: '3.0.0' }
    ])
    expect(toastMocks.success).toHaveBeenCalledTimes(2)
    expect(toastMocks.success).toHaveBeenLastCalledWith('3 plugins updated')
  })
})
