import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { reloadOrcaRenderer } from './GhAuthErrorHelp'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GitHub Project auth remediation host routing', () => {
  it('does not force navigation when the checkpointed reload is refused', async () => {
    const reload = vi.fn(() => Promise.reject(new Error('checkpoint failed')))
    const locationReload = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      api: { app: { reload } },
      location: { reload: locationReload }
    })

    reloadOrcaRenderer()
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1))

    expect(reload).toHaveBeenCalledTimes(1)
    expect(locationReload).not.toHaveBeenCalled()
  })
})
