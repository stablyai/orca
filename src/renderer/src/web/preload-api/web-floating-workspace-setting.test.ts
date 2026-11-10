// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getStoredSettings } from './web-preferences-store'
import { SETTINGS_STORAGE_KEY } from './web-storage'

vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => null
}))

beforeEach(() => localStorage.clear())

// #40268: an older web build could store the floating workspace as on, which left a panel whose
// terminal and Markdown actions did nothing.
it('never reports the floating workspace as on in the browser client', () => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ floatingTerminalEnabled: true }))

  expect(getStoredSettings().floatingTerminalEnabled).toBe(false)
})
