import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readTauriPtyCwd } from './web-tauri-pty-cwd'

const { callEnvironmentEnvelope } = vi.hoisted(() => ({ callEnvironmentEnvelope: vi.fn() }))
vi.mock('../runtime/client/web-runtime-calls', () => ({ callEnvironmentEnvelope }))

function binding(incarnationId: string | null = 'inc-1') {
  return { handle: 'term-1', cwd: '/repo', endpoint: { handle: 'term-1', incarnationId } }
}

function success(cwd: unknown) {
  return { id: 'cwd-1', ok: true, result: { cwd }, _meta: { runtimeId: 'runtime-1' } }
}

function failure(code: string) {
  return {
    id: 'cwd-1',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'runtime-1' }
  }
}

const ptyId = 'remote:owning-environment@@term-1'

describe('Tauri live PTY cwd', () => {
  beforeEach(() => callEnvironmentEnvelope.mockReset())

  it('queries the encoded owner and fences the result to the PTY incarnation', async () => {
    const state = binding()
    callEnvironmentEnvelope.mockResolvedValueOnce(success('/repo/packages/app'))
    await expect(readTauriPtyCwd(ptyId, () => state)).resolves.toBe('/repo/packages/app')
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith('owning-environment', 'terminal.cwd', {
      terminal: 'term-1',
      expectedIncarnationId: 'inc-1'
    })
    expect(state.cwd).toBe('/repo/packages/app')
  })

  it('omits the fence when a legacy spawn did not supply an incarnation', async () => {
    const state = binding(null)
    callEnvironmentEnvelope.mockResolvedValueOnce(success('/repo/current'))
    await expect(readTauriPtyCwd(ptyId, () => state)).resolves.toBe('/repo/current')
    expect(callEnvironmentEnvelope).toHaveBeenCalledWith('owning-environment', 'terminal.cwd', {
      terminal: 'term-1'
    })
    expect(state.cwd).toBe('/repo/current')
  })

  it.each([null, '', '   ', 42])(
    'does not present an unavailable cwd as the startup cwd (%j)',
    async (cwd) => {
      const state = binding()
      callEnvironmentEnvelope.mockResolvedValueOnce(success(cwd))
      await expect(readTauriPtyCwd(ptyId, () => state)).resolves.toBe('')
    }
  )

  it('falls back to the known cwd only when an older host lacks the method', async () => {
    const state = binding()
    callEnvironmentEnvelope.mockResolvedValueOnce(failure('method_not_found'))
    await expect(readTauriPtyCwd(ptyId, () => state)).resolves.toBe('/repo')
  })

  it.each(['connection_closed', 'forbidden', 'terminal_handle_stale'])(
    'surfaces %s rather than a stale directory',
    async (code) => {
      const state = binding()
      callEnvironmentEnvelope.mockResolvedValueOnce(failure(code))
      await expect(readTauriPtyCwd(ptyId, () => state)).rejects.toThrow(code)
    }
  )

  it('does not query an absent binding or guess an owner for legacy ids', async () => {
    await expect(readTauriPtyCwd(ptyId, () => null)).resolves.toBe('')
    await expect(readTauriPtyCwd('remote:term-1', () => binding())).resolves.toBe('')
    expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
  })

  it('discards a response when the renderer rebinds during the request', async () => {
    const previous = binding()
    let current = previous
    callEnvironmentEnvelope.mockImplementationOnce(async () => {
      current = binding('inc-2')
      return success('/old-process')
    })
    await expect(readTauriPtyCwd(ptyId, () => current)).resolves.toBe('')
    expect(previous.cwd).toBe('/repo')
    expect(current.cwd).toBe('/repo')
  })
})
