// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getStoredSettings } from './web-preferences-store'
import { SETTINGS_STORAGE_KEY } from './web-storage'

vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => null
}))

beforeEach(() => localStorage.clear())

it('keeps publishing off in the web fallback until a stored web setting grants it', () => {
  expect(getStoredSettings().artifactSharingEnabled).toBe(false)

  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ artifactSharingEnabled: true }))
  expect(getStoredSettings().artifactSharingEnabled).toBe(true)
})
