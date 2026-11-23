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
