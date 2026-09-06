import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

import { spawnIpcPty } from './ipc-pty-spawn-request'

describe('spawnIpcPty provider resume', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const spawn = vi.fn()

  beforeEach(() => {
    callRuntimeRpc.mockReset()
    spawn.mockReset()
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: { ...originalWindow?.api, pty: { ...originalWindow?.api?.pty, spawn } }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('routes a local provider resume through host authority', async () => {
    callRuntimeRpc.mockResolvedValue({
      disposition: 'adopted',
      terminal: { ptyId: 'pty-owned' }
    })

    await expect(
      spawnIpcPty(
        {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          launchAgent: 'codex',
          resumeProviderSession: { key: 'session_id', id: 'thread-1' }
        },
        { url: '', callbacks: {} }
      )
    ).resolves.toMatchObject({ id: 'pty-owned', isReattach: true })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.ensureAgentSession',
      expect.objectContaining({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-1' }
      })
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a rejected authority resume to the provisional tab owner', async () => {
    callRuntimeRpc.mockRejectedValue(new Error('thread already has an active writer'))
    const onProviderSessionResumeFailure = vi.fn()

    await expect(
      spawnIpcPty(
        {
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          leafId: '11111111-1111-4111-8111-111111111111',
          launchAgent: 'codex',
          resumeProviderSession: { key: 'session_id', id: 'thread-1' },
          onProviderSessionResumeFailure
        },
        { url: '', callbacks: {} }
      )
    ).rejects.toThrow('thread already has an active writer')
    expect(onProviderSessionResumeFailure).toHaveBeenCalledOnce()
    expect(spawn).not.toHaveBeenCalled()
  })
})
