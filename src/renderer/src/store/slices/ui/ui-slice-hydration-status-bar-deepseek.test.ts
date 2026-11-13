import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePersistedUI } from './ui-slice-test-harness'
import { hydrateStatusBarItems } from './ui-slice-hydration-status-bar-items'

const settledFlags = {
  _portsStatusBarDefaultAdded: true,
  _kimiStatusBarDefaultAdded: true,
  _minimaxStatusBarDefaultAdded: true,
  _antigravityStatusBarDefaultAdded: true,
  _grokStatusBarDefaultAdded: true,
  _cursorStatusBarDefaultAdded: true,
  _zcodeStatusBarDefaultAdded: true,
  _deepseekStatusBarDefaultAdded: true,
  _museStatusBarDefaultAdded: true
} as const

describe('hydrateStatusBarItems DeepSeek default', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds DeepSeek once for older persisted UI', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const items = hydrateStatusBarItems(
      makePersistedUI({
        statusBarItems: ['claude'],
        _deepseekStatusBarDefaultAdded: false
      })
    )
    expect(items).toContain('deepseek')
    expect(setUI).toHaveBeenCalledWith(
      expect.objectContaining({
        _deepseekStatusBarDefaultAdded: true
      })
    )
  })

  it('leaves a hidden DeepSeek item hidden after the one-shot flag', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const items = hydrateStatusBarItems(
      makePersistedUI({
        statusBarItems: ['claude'],
        ...settledFlags
      })
    )
    expect(items).not.toContain('deepseek')
    expect(setUI).not.toHaveBeenCalled()
  })
})
