import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '../../../store/index'
import { createAgentAvailabilityUpdateQueue } from './agent-settings-update-queue'

describe('agent availability settings', () => {
  it('continues serializing requests after a rejected write', async () => {
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: null,
      disabledTuiAgents: []
    }
    let latest = settings
    const updateSettings = vi
      .fn<(update: Partial<GlobalSettings>) => Promise<void>>()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockImplementationOnce(async (update) => {
        latest = { ...latest, ...update }
      })
    const enqueue = createAgentAvailabilityUpdateQueue()

    await expect(
      enqueue({
        getSettings: () => latest,
        fallbackSettings: settings,
        updateSettings,
        agentId: 'claude',
        enabled: false
      })
    ).rejects.toThrow('write failed')
    await enqueue({
      getSettings: () => latest,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'codex',
      enabled: false
    })

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings.mock.calls[1][0]).toMatchObject({ disabledTuiAgents: ['codex'] })
  })
})

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function flushPromiseQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgentsPane', () => {
  it('serializes rapid availability writes against the latest settings snapshot', async () => {
    const queueAvailabilityUpdate = createAgentAvailabilityUpdateQueue()
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      defaultTuiAgent: null,
      disabledTuiAgents: []
    }
    const writes: Deferred[] = []
    const updates: Partial<GlobalSettings>[] = []

    useAppStore.setState({ settings })
    const updateSettings = vi.fn((update: Partial<GlobalSettings>) => {
      updates.push(update)
      const nextSettings = {
        ...(useAppStore.getState().settings ?? settings),
        ...update
      }
      const write = createDeferred()
      writes.push(write)
      return write.promise.then(() => {
        useAppStore.setState({ settings: nextSettings })
      })
    })

    const firstWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'claude',
      enabled: false
    })
    const secondWrite = queueAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'codex',
      enabled: false
    })

    await flushPromiseQueue()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updates[0]).toMatchObject({ disabledTuiAgents: ['claude'] })

    writes[0].resolve()
    await firstWrite
    await flushPromiseQueue()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updates[1]).toMatchObject({ disabledTuiAgents: ['claude', 'codex'] })

    writes[1].resolve()
    await secondWrite
  })
})
