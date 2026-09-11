import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeResult = vi.hoisted(() => vi.fn())

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult, getRemoteRuntimeStatus: vi.fn() }))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'local' })
}))
vi.mock('./web-storage', () => ({ getBrowserPlatform: () => 'win32' }))

import { createPreflightApi } from './web-host-capability-api'

describe('web preflight API agent detection', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset().mockResolvedValue([])
  })

  it('forwards the WSL context a paired client detects with', async () => {
    await createPreflightApi().detectAgents({ wslDistro: 'Ubuntu-24.04' })

    expect(callRuntimeResult).toHaveBeenCalledWith('preflight.detectAgents', {
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('keeps refresh on the same target so it cannot replace the list with a host-local one', async () => {
    callRuntimeResult.mockResolvedValue({ agents: [] })

    await createPreflightApi().refreshAgents({ wslDistro: 'Ubuntu-24.04' })

    expect(callRuntimeResult).toHaveBeenCalledWith('preflight.refreshAgents', {
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('sends no params when no target is selected', async () => {
    await createPreflightApi().detectAgents()

    expect(callRuntimeResult).toHaveBeenCalledWith('preflight.detectAgents', undefined)
  })
})
