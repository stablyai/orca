import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalProviderSnapshotCapabilities,
  refreshTerminalProviderSnapshotCapabilities,
  terminalProviderAllowsParking
} from './terminal-provider-snapshot-capability'
import { markTerminalProviderSessionLive } from './terminal-provider-snapshot-revived-reask'

const ptyId = 'repo::/work/wt-1@@a1b2c3d4'

afterEach(() => {
  clearTerminalProviderSnapshotCapabilities()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('restored terminal revived under its old id', () => {
  it('becomes parkable once its pane binds the revived session', async () => {
    let sessionExists = false
    const resolve = async (ids: string[]) => ids.map((id) => ({ id, authoritative: sessionExists }))
    vi.stubGlobal('window', {
      api: { pty: { getAuthoritativeBufferSnapshotCapabilities: resolve } }
    })

    await refreshTerminalProviderSnapshotCapabilities([ptyId], resolve)
    expect(terminalProviderAllowsParking(ptyId)).toBe(false)

    sessionExists = true
    markTerminalProviderSessionLive(ptyId)
    await vi.waitFor(() => expect(terminalProviderAllowsParking(ptyId)).toBe(true))
  })
})

describe('revived sessions the host never answers for', () => {
  it('stop being asked after their own grace even while other sessions keep reviving', async () => {
    vi.useFakeTimers()
    const stuck = 'repo::/work/wt-1@@stuck'
    const others = Array.from({ length: 20 }, (_, i) => `repo::/work/wt-1@@other-${i}`)
    let answer: boolean | null = false
    let lastAsked: string[] = []
    const resolve = async (ids: string[]) => {
      lastAsked = ids
      return ids.map((id) => ({ id, authoritative: answer }))
    }
    vi.stubGlobal('window', {
      api: { pty: { getAuthoritativeBufferSnapshotCapabilities: resolve } }
    })
    await refreshTerminalProviderSnapshotCapabilities([stuck, ...others], resolve)

    answer = null
    markTerminalProviderSessionLive(stuck)
    for (const other of others) {
      markTerminalProviderSessionLive(other)
      await vi.advanceTimersByTimeAsync(31_000)
    }

    expect(lastAsked).not.toContain(stuck)
    expect(terminalProviderAllowsParking(stuck)).toBe(false)
  })
})
