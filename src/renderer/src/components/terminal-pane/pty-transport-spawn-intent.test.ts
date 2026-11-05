import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

const RESUME = { key: 'session_id', id: 'provider-session-1' } as const

describe('createIpcPtyTransport: restore spawn intent', () => {
  const originalWindow: typeof window | undefined = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  it('declares the intent only when the spawn resumes an agent', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    await createIpcPtyTransport().connect({
      url: '',
      resumeProviderSession: RESUME,
      resumeSpawnIntent: 'automatic-restore',
      callbacks: {}
    })
    await createIpcPtyTransport().connect({
      url: '',
      resumeSpawnIntent: 'automatic-restore',
      callbacks: {}
    })
    const [resumed, plain] = vi.mocked(window.api.pty.spawn).mock.calls.map(([args]) => args)
    expect(resumed).toMatchObject({ spawnIntent: 'automatic-restore' })
    expect(plain).not.toHaveProperty('spawnIntent')
  })

  it('reports a deferral to the pane instead of an error toast', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(
      new Error("Error invoking remote method 'pty:spawn': Error: terminal_spawn_deferred:live_cap")
    )
    const onError = vi.fn()
    const onSpawnDeferred = vi.fn()

    const result = await createIpcPtyTransport().connect({
      url: '',
      resumeProviderSession: RESUME,
      resumeSpawnIntent: 'automatic-restore',
      callbacks: { onError, onSpawnDeferred }
    })

    expect(result).toBeUndefined()
    expect(onSpawnDeferred).toHaveBeenCalledWith('live_cap')
    expect(onError).not.toHaveBeenCalled()
  })
})
