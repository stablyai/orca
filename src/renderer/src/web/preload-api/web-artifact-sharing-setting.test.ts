// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { getStoredSettings } from './web-preferences-store'
import { SETTINGS_STORAGE_KEY } from './web-storage'

vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => null
}))

beforeEach(() => localStorage.clear())

it('reports publishing off until the host grant has been mirrored', () => {
  expect(getStoredSettings().artifactSharingEnabled).toBe(false)

  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ artifactSharingEnabled: true }))
  expect(getStoredSettings().artifactSharingEnabled).toBe(true)
})
