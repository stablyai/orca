import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './agent-availability-settings'

describe('agent availability settings', () => {
  it('normalizes duplicates and unknown ids before applying a request', () => {
    expect(
      buildAgentAvailabilitySettingsUpdate(
        {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['claude', 'claude', 'unknown-agent'] as never[]
        },
        'codex',
        false
      )
    ).toEqual({
      disabledTuiAgents: ['claude', 'codex'],
      defaultTuiAgent: null
    })
  })

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
