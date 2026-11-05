import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useAppStore } from '../../../store/index'
import { createAgentAvailabilityUpdateQueue } from '../../../lib/agent-session/launch/agent-settings-update-queue'

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
