import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTerminalSideEffectFactConsumersForTest,
  isMainTerminalSideEffectAuthorityForPty
} from './terminal-side-effect-facts-handler'

describe('isMainTerminalSideEffectAuthorityForPty', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    _resetTerminalSideEffectFactConsumersForTest()
    delete (globalThis as { window?: unknown }).window
  })

  afterEach(() => {
    _resetTerminalSideEffectFactConsumersForTest()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  function setPersistedSettingsSync(settings: unknown): void {
    ;(globalThis as { window: unknown }).window = {
      api: { settings: { getSync: () => settings } }
    }
  }

  it('is on by default for PTYs whose bytes transit local main', () => {
    expect(
      isMainTerminalSideEffectAuthorityForPty({ settings: {}, runtimeEnvironmentId: null })
    ).toBe(true)
    // Null startup settings must not disable default-on authority before hydration.
    expect(
      isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })
    ).toBe(true)
  })

  it('is off for remote-runtime PTYs regardless of the setting', () => {
    expect(
      isMainTerminalSideEffectAuthorityForPty({
        settings: { terminalMainSideEffectAuthority: true },
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe(false)
  })

  it('is off when the kill switch is disabled', () => {
    expect(
      isMainTerminalSideEffectAuthorityForPty({
        settings: { terminalMainSideEffectAuthority: false },
        runtimeEnvironmentId: null
      })
    ).toBe(false)
  })

  it('honors the persisted kill switch before settings hydrate', () => {
    // Creation-time authority must honor the persisted off switch even before settings hydrate.
    setPersistedSettingsSync({ terminalMainSideEffectAuthority: false })

    expect(
      isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })
    ).toBe(false)
  })

  it('stays on pre-hydration when the persisted switch is on or unset', () => {
    setPersistedSettingsSync({ terminalMainSideEffectAuthority: true })
    expect(
      isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })
    ).toBe(true)

    _resetTerminalSideEffectFactConsumersForTest()
    setPersistedSettingsSync({})
    expect(
      isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })
    ).toBe(true)
  })

  it('prefers hydrated settings over the persisted sync read', () => {
    setPersistedSettingsSync({ terminalMainSideEffectAuthority: false })

    expect(
      isMainTerminalSideEffectAuthorityForPty({
        settings: { terminalMainSideEffectAuthority: true },
        runtimeEnvironmentId: null
      })
    ).toBe(true)
  })

  it('caches the sync read so panes do not re-block per bind', () => {
    const getSync = vi.fn(() => ({ terminalMainSideEffectAuthority: false }))
    ;(globalThis as { window: unknown }).window = { api: { settings: { getSync } } }

    isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })
    isMainTerminalSideEffectAuthorityForPty({ settings: null, runtimeEnvironmentId: null })

    expect(getSync).toHaveBeenCalledTimes(1)
  })
})
