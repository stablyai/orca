import { expect, it } from 'vitest'
import {
  observeAgentPickerAcquisition,
  retryAgentPickerCatalog
} from './agent-launch-picker-acquisition'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'

const ENTRY: AgentPickerEntry = {
  agent: 'antigravity',
  label: 'Antigravity',
  rows: [],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: { options: {} },
  structured: { options: {} },
  catalog: { origin: 'unknown' }
}
const catalog = (id: string): AgentPickerEntry['catalog'] => ({
  origin: 'probe',
  fetchedAt: 0,
  models: [{ id, label: id, isDefault: false, efforts: [] }]
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('a Refresh of a settled catalog shows what the listing it started found', async () => {
  // As the host answers: a read that doesn't wait gets the saved catalog while the relist runs.
  let listed = catalog('before-refresh')
  let shown: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'refresh-settled',
    [ENTRY],
    {
      catalog: async (_entry, waitForListing, _signal, relist = false) => {
        const saved = listed
        if (relist) {
          listed = catalog('after-refresh')
        }
        return waitForListing ? listed : saved
      },
      support: async () => undefined
    },
    { publish: (entries) => (shown = entries), selected: () => 'antigravity' }
  )
  await settle()
  expect(shown[0].catalogRead).toBe('settled')
  retryAgentPickerCatalog('refresh-settled', 'antigravity', true)
  await settle()
  expect(shown[0].catalog.origin !== 'unknown' && shown[0].catalog.models[0].id).toBe(
    'after-refresh'
  )
  expect(shown[0].catalogRead).toBe('settled')
  stop()
})
