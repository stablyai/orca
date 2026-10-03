import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  buildAgentIncognitoSettingsUpdate,
  createAgentIncognitoUpdateQueue
} from './agent-incognito-settings'

describe('agent incognito settings', () => {
  it('adds a capable agent and drops non-capable/unknown ids while normalizing', () => {
    // Only incognito-capable agents survive: a stale 'claude' cannot persist as incognito.
    expect(
      buildAgentIncognitoSettingsUpdate(
        { terminalIncognitoAgents: ['omp', 'omp', 'claude', 'unknown-agent'] as never[] },
        'pi',
        true
      )
    ).toEqual({
      terminalIncognitoAgents: ['omp', 'pi']
    })
  })

  it('removes an agent from the incognito list when toggled off', () => {
    expect(
      buildAgentIncognitoSettingsUpdate({ terminalIncognitoAgents: ['pi', 'omp'] }, 'pi', false)
    ).toEqual({
      terminalIncognitoAgents: ['omp']
    })
  })

  it('is idempotent when enabling an already-incognito agent', () => {
    expect(
      buildAgentIncognitoSettingsUpdate({ terminalIncognitoAgents: ['pi'] }, 'pi', true)
    ).toEqual({
      terminalIncognitoAgents: ['pi']
    })
  })

  it('continues serializing requests after a rejected write', async () => {
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      terminalIncognitoAgents: []
    }
    let latest = settings
    const updateSettings = vi
      .fn<(update: Partial<GlobalSettings>) => Promise<void>>()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockImplementationOnce(async (update) => {
        latest = { ...latest, ...update }
      })
    const enqueue = createAgentIncognitoUpdateQueue()

    await expect(
      enqueue({
        getSettings: () => latest,
        fallbackSettings: settings,
        updateSettings,
        agentId: 'pi',
        incognito: true
      })
    ).rejects.toThrow('write failed')
    await enqueue({
      getSettings: () => latest,
      fallbackSettings: settings,
      updateSettings,
      agentId: 'omp',
      incognito: true
    })

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings.mock.calls[1][0]).toMatchObject({ terminalIncognitoAgents: ['omp'] })
  })
})
