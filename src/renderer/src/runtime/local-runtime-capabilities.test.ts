// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readLocalRuntimeCapabilities,
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from './local-runtime-capabilities'

describe('local runtime capabilities', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('fails closed until the live host advertises support', async () => {
    const getStatus = vi.fn(async () => ({ capabilities: ['agent-session.structured.v1'] }))
    Object.assign(window, { api: { runtime: { getStatus } } })

    expect(readLocalRuntimeCapabilities()).toEqual([])
    await expect(refreshLocalRuntimeCapabilities()).resolves.toEqual([
      'agent-session.structured.v1'
    ])
    expect(readLocalRuntimeCapabilities()).toEqual(['agent-session.structured.v1'])
  })

  it('coalesces concurrent live status reads', async () => {
    let resolve!: (value: { capabilities: string[] }) => void
    const getStatus = vi.fn(
      () => new Promise<{ capabilities: string[] }>((next) => (resolve = next))
    )
    Object.assign(window, { api: { runtime: { getStatus } } })

    const first = refreshLocalRuntimeCapabilities()
    const second = refreshLocalRuntimeCapabilities()
    resolve({ capabilities: ['agent-session.structured.v1'] })

    await expect(Promise.all([first, second])).resolves.toEqual([
      ['agent-session.structured.v1'],
      ['agent-session.structured.v1']
    ])
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('clears stale support when live status becomes unavailable', async () => {
    setLocalRuntimeCapabilitiesForTests(['agent-session.structured.v1'])
    Object.assign(window, {
      api: {
        runtime: {
          getStatus: vi.fn(async () => {
            throw new Error('offline')
          })
        }
      }
    })

    await expect(refreshLocalRuntimeCapabilities()).resolves.toEqual([])
    expect(readLocalRuntimeCapabilities()).toEqual([])
  })
})
