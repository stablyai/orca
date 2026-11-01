import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track, trackWithResult } from './telemetry'

describe('telemetry observation result', () => {
  const bridgeTrack = vi.fn()

  beforeEach(() => {
    bridgeTrack.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('window', { api: { telemetryTrack: bridgeTrack } })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([true, false, undefined])(
    'preserves the bridge result %s, including older bridges',
    async (result) => {
      bridgeTrack.mockResolvedValue(result)

      expect(await trackWithResult('agent_dashboard_active', { surface: 'popout' })).toBe(result)
      expect(bridgeTrack).toHaveBeenCalledWith('agent_dashboard_active', { surface: 'popout' })
    }
  )

  it('lets IPC failures retry and keeps fire-and-forget calls from rejecting', async () => {
    bridgeTrack.mockRejectedValue(new Error('IPC unavailable'))

    expect(await trackWithResult('agent_dashboard_active', { surface: 'popout' })).toBe(false)
    expect(track('agent_dashboard_opened', { surface: 'popout' })).toBeUndefined()
    await Promise.resolve()
  })

  it('returns false when the bridge is missing or throws synchronously', async () => {
    vi.stubGlobal('window', {})
    expect(await trackWithResult('agent_dashboard_active', { surface: 'popout' })).toBe(false)

    vi.stubGlobal('window', {
      api: {
        telemetryTrack: () => {
          throw new Error('preload mismatch')
        }
      }
    })
    expect(await trackWithResult('agent_dashboard_active', { surface: 'popout' })).toBe(false)
  })
})
