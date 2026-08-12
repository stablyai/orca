import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  readSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn()
}))

vi.mock('node:fs', () => ({
  opendirSync: () => ({
    closeSync: fsMocks.closeSync,
    readSync: fsMocks.readSync
  }),
  statSync: fsMocks.statSync,
  unlinkSync: fsMocks.unlinkSync
}))

import {
  AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES,
  sweepStaleAgentHookEndpointTemps
} from './agent-hook-endpoint-temp-cleanup'

describe('agent hook endpoint temp cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.statSync.mockReturnValue({ mtimeMs: 0 })
  })

  it('stops an unbounded directory source at the scan cap', () => {
    let entry = 0
    fsMocks.readSync.mockImplementation(() => ({
      name: `.endpoint-${(entry += 1)}.tmp`
    }))

    sweepStaleAgentHookEndpointTemps('/endpoint', 10 * 60 * 1000)

    expect(fsMocks.readSync).toHaveBeenCalledTimes(AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES)
    expect(fsMocks.unlinkSync).toHaveBeenCalledTimes(AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES)
    expect(fsMocks.closeSync).toHaveBeenCalledOnce()
  })

  it('only removes stale endpoint temp files', () => {
    fsMocks.readSync
      .mockReturnValueOnce({ name: '.endpoint-stale.tmp' })
      .mockReturnValueOnce({ name: '.endpoint-fresh.tmp' })
      .mockReturnValueOnce({ name: 'endpoint.env' })
      .mockReturnValueOnce(null)
    fsMocks.statSync
      .mockReturnValueOnce({ mtimeMs: 0 })
      .mockReturnValueOnce({ mtimeMs: 9 * 60 * 1000 })

    sweepStaleAgentHookEndpointTemps('/endpoint', 10 * 60 * 1000)

    expect(fsMocks.unlinkSync).toHaveBeenCalledOnce()
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(expect.stringContaining('.endpoint-stale.tmp'))
  })
})
