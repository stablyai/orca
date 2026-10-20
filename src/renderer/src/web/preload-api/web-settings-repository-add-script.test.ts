// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebSettingsApi } from './web-settings-api'
import { SETTINGS_STORAGE_KEY } from './web-storage'

type TestEnvironment = { id: string; createdAt: number }
const runtime = vi.hoisted((): { env: TestEnvironment | null } => ({ env: null }))
const call = vi.hoisted(() => vi.fn())
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: call }))
vi.mock('./web-runtime-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireActiveEnvironmentOrNull: () => runtime.env
}))

const SCRIPT = 'echo from-browser'

function settingsApi() {
  const api = createWebSettingsApi().settings
  if (!api) {
    throw new Error('settings api missing')
  }
  return api
}

function storedText(): string {
  return window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? ''
}

describe('web settings never hold the repository add script', () => {
  beforeEach(() => {
    window.localStorage.clear()
    call.mockReset()
    runtime.env = null
  })

  it('does not save a generic update locally without a host', async () => {
    const result = await settingsApi().set({ repositoryAddScript: SCRIPT })
    expect(storedText()).not.toContain('from-browser')
    expect(result.repositoryAddScript).toBeUndefined()
  })

  it('neither saves locally nor sends it to the active host', async () => {
    runtime.env = { id: 'host-a', createdAt: 1 }
    const result = await settingsApi().set({ repositoryAddScript: SCRIPT })
    expect(storedText()).not.toContain('from-browser')
    expect(result.repositoryAddScript).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })

  it('strips the script from the host response to an unrelated update', async () => {
    runtime.env = { id: 'host-a', createdAt: 1 }
    call.mockResolvedValue({
      settings: { compactWorktreeCards: true, repositoryAddScript: SCRIPT }
    })
    const result = await settingsApi().set({ compactWorktreeCards: true })
    expect(call).toHaveBeenCalledWith(
      'settings.update',
      { compactWorktreeCards: true },
      expect.anything()
    )
    expect(storedText()).not.toContain('from-browser')
    expect(result.repositoryAddScript).toBeUndefined()
  })

  it('does not mirror it on read and ignores stored browser data', async () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ repositoryAddScript: 'echo stale' })
    )
    expect((await settingsApi().get()).repositoryAddScript).toBeUndefined()
    expect(settingsApi().getSync()?.repositoryAddScript).toBeUndefined()

    runtime.env = { id: 'host-a', createdAt: 1 }
    call.mockResolvedValue({ settings: { repositoryAddScript: SCRIPT } })
    expect((await settingsApi().get()).repositoryAddScript).toBeUndefined()
    expect(storedText()).not.toContain('from-browser')
    expect(storedText()).not.toContain('stale')
  })
})
