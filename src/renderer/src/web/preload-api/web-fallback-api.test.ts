import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFallbackProxy } from './web-fallback-api'

describe('web fallback proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once per unimplemented namespace and still returns the default result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    type Api = { first: () => Promise<unknown>; second: () => Promise<unknown> }
    const missing: Api = createFallbackProxy(['missingNamespace'])
    const other: Api = createFallbackProxy(['otherMissingNamespace'])

    await expect(missing.first()).resolves.toBeUndefined()
    await missing.second()
    await other.first()

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain('window.api.missingNamespace.first')
    expect(warn.mock.calls[1]?.[0]).toContain('window.api.otherMissingNamespace.first')
  })

  it('does not warn when a namespace routes calls through an override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const routed: { call: () => unknown } = createFallbackProxy(['routedNamespace'], () => 'ok')

    expect(routed.call()).toBe('ok')
    expect(warn).not.toHaveBeenCalled()
  })
})
