import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

describe('web shell URL policy', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('opens HTTP links but refuses custom app schemes without a controlled confirmation UI', async () => {
    const { api, window } = await installApi('Linux')
    const open = vi.fn()
    const confirm = vi.fn()
    Object.assign(window, { open, confirm })

    await api.shell.openUrl('hTtPs://example.com/path')
    expect(open).toHaveBeenCalledWith('https://example.com/path', '_blank', 'noopener,noreferrer')

    open.mockClear()
    await api.shell.openUrl('obsidian://vault/note')
    expect(confirm).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})
