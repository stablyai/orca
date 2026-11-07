import { expect, it } from 'vitest'
import { observeAgentPickerAcquisition } from './agent-launch-picker-acquisition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const model = (id: string) => ({ id, label: id, isDefault: false, efforts: [] })

it('shows the saved model listing while the waiting read is still refreshing it', async () => {
  const codex: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' }
  }
  const fresh = Promise.withResolvers<AgentPickerEntry['catalog']>()
  let published: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'interim-catalog',
    [codex],
    {
      catalog: (_entry, interim) => {
        interim({ origin: 'probe', fetchedAt: 1, models: [model('saved')] })
        return fresh.promise
      },
      support: async () => undefined
    },
    { selected: () => undefined, publish: (entries) => (published = entries) }
  )

  expect(published[0].catalog).toMatchObject({ models: [{ id: 'saved' }] })
  expect(published[0].catalogRead).toBe('pending')

  fresh.resolve({ origin: 'probe', fetchedAt: 2, models: [model('fresh')] })
  await expect.poll(() => published[0].catalogRead).toBe('settled')
  expect(published[0].catalog).toMatchObject({ models: [{ id: 'fresh' }] })
  stop()
})
