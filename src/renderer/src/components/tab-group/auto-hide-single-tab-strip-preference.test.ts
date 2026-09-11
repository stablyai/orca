import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadModule(getSync?: () => unknown): Promise<{
  isAutoHideSingleTabStripEnabled: (settings: unknown) => boolean
}> {
  vi.resetModules()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: getSync ? { api: { settings: { getSync } } } : {}
  })
  return (await import('./auto-hide-single-tab-strip-preference')) as never
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('isAutoHideSingleTabStripEnabled', () => {
  it('reads hydrated settings without touching the sync bridge', async () => {
    const getSync = vi.fn(() => ({ autoHideSingleTabStrip: true }))
    const { isAutoHideSingleTabStripEnabled } = await loadModule(getSync)
    expect(isAutoHideSingleTabStripEnabled({ autoHideSingleTabStrip: false })).toBe(false)
    expect(getSync).not.toHaveBeenCalled()
  })

  it('falls back to the persisted flag before settings hydrate', async () => {
    const { isAutoHideSingleTabStripEnabled } = await loadModule(() => ({
      autoHideSingleTabStrip: true
    }))
    expect(isAutoHideSingleTabStripEnabled(null)).toBe(true)
    expect(isAutoHideSingleTabStripEnabled(undefined)).toBe(true)
  })

  it('reads the sync bridge once per session', async () => {
    const getSync = vi.fn(() => ({ autoHideSingleTabStrip: true }))
    const { isAutoHideSingleTabStripEnabled } = await loadModule(getSync)
    isAutoHideSingleTabStripEnabled(null)
    isAutoHideSingleTabStripEnabled(null)
    expect(getSync).toHaveBeenCalledTimes(1)
  })

  it('stays off when the bridge is missing or throws', async () => {
    const missing = await loadModule()
    expect(missing.isAutoHideSingleTabStripEnabled(null)).toBe(false)

    const throwing = await loadModule(() => {
      throw new Error('ipc down')
    })
    expect(throwing.isAutoHideSingleTabStripEnabled(null)).toBe(false)
  })
})
