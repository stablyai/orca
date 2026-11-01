// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  readLocalRuntimeCapabilityObservation,
  subscribeLocalRuntimeCapabilityObservation,
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from './local-runtime-capabilities'

describe('local runtime capabilities', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
  })

  it('starts unknown while the array reader stays compatible', async () => {
    vi.resetModules()
    const fresh = await import('./local-runtime-capabilities')
    expect(fresh.readLocalRuntimeCapabilitiesOrUnknown()).toBeNull()
    expect(fresh.readLocalRuntimeCapabilities()).toEqual([])
  })

  it.each([{}, { capabilities: [] }])(
    'treats a successful legacy or empty response as known denial: %j',
    async (status) => {
      Object.assign(window, { api: { runtime: { getStatus: vi.fn(async () => status) } } })
      await expect(refreshLocalRuntimeCapabilities()).resolves.toEqual([])
      expect(readLocalRuntimeCapabilitiesOrUnknown()).toEqual([])
    }
  )

  it('fails closed until the live host advertises support', async () => {
    const getStatus = vi.fn(async () => ({ capabilities: ['agent-session.structured.v1'] }))
    Object.assign(window, { api: { runtime: { getStatus } } })

    expect(readLocalRuntimeCapabilities()).toEqual([])
    await expect(refreshLocalRuntimeCapabilities()).resolves.toEqual([
      'agent-session.structured.v1'
    ])
    expect(readLocalRuntimeCapabilities()).toEqual(['agent-session.structured.v1'])
    expect(readLocalRuntimeCapabilitiesOrUnknown()).toEqual(['agent-session.structured.v1'])
  })

  it('coalesces concurrent live status reads', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    let resolve!: (value: { capabilities: string[] }) => void
    const getStatus = vi.fn(
      () => new Promise<{ capabilities: string[] }>((next) => (resolve = next))
    )
    Object.assign(window, { api: { runtime: { getStatus } } })

    const first = refreshLocalRuntimeCapabilities()
    const second = refreshLocalRuntimeCapabilities()
    expect(readLocalRuntimeCapabilityObservation().state).toBe('pending')
    resolve({ capabilities: ['agent-session.structured.v1'] })

    await expect(Promise.all([first, second])).resolves.toEqual([
      ['agent-session.structured.v1'],
      ['agent-session.structured.v1']
    ])
    expect(first).toBe(second)
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('clears stale support when live status becomes unavailable', async () => {
    const outcomes: string[] = []
    const stop = subscribeLocalRuntimeCapabilityObservation(() =>
      outcomes.push(readLocalRuntimeCapabilityObservation().state)
    )
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
    expect(readLocalRuntimeCapabilitiesOrUnknown()).toBeNull()
    expect(readLocalRuntimeCapabilityObservation().state).toBe('unavailable')

    window.api.runtime.getStatus = vi
      .fn()
      .mockResolvedValue({ capabilities: ['agent-session.structured.v1'] })
    const retry = refreshLocalRuntimeCapabilities()
    expect(readLocalRuntimeCapabilityObservation().state).toBe('unavailable')
    await retry
    expect(readLocalRuntimeCapabilitiesOrUnknown()).toEqual(['agent-session.structured.v1'])
    expect(outcomes).toEqual(['unavailable', 'known'])
    stop()
  })
  it('ensure probes the runtime when no answer has landed yet', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi.fn(async () => ({ capabilities: ['agent-session.structured.v1'] }))
    Object.assign(window, { api: { runtime: { getStatus } } })

    await expect(ensureLocalRuntimeCapabilities()).resolves.toEqual(['agent-session.structured.v1'])
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('ensure returns the cached answer without probing again', async () => {
    setLocalRuntimeCapabilitiesForTests(['agent-session.structured.v1'])
    const getStatus = vi.fn(async () => ({ capabilities: [] }))
    Object.assign(window, { api: { runtime: { getStatus } } })

    await expect(ensureLocalRuntimeCapabilities()).resolves.toEqual(['agent-session.structured.v1'])
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('ensure stays unknown after a failed probe and re-probes on the next call', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ capabilities: ['agent-session.structured.v1'] })
    Object.assign(window, { api: { runtime: { getStatus } } })

    // Failed probes prove no unsupported capability; keep unknown and let later callers retry.
    await expect(ensureLocalRuntimeCapabilities()).resolves.toBeNull()
    await expect(ensureLocalRuntimeCapabilities()).resolves.toEqual(['agent-session.structured.v1'])
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('ensure never rejects when the preload bridge is missing', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    Reflect.deleteProperty(window, 'api')

    await expect(ensureLocalRuntimeCapabilities()).resolves.toBeNull()
  })

  it('coalesces concurrent ensure callers onto one probe', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const getStatus = vi.fn(async () => ({ capabilities: ['agent-session.structured.v1'] }))
    Object.assign(window, { api: { runtime: { getStatus } } })

    await expect(
      Promise.all([ensureLocalRuntimeCapabilities(), ensureLocalRuntimeCapabilities()])
    ).resolves.toEqual([['agent-session.structured.v1'], ['agent-session.structured.v1']])
    expect(getStatus).toHaveBeenCalledOnce()
  })
})
