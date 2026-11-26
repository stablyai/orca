import { expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

it('keeps the latest Activity agent selection across stale persistence snapshots', () => {
  const store = createUIStore()
  const unfiltered = makePersistedUI({ agentsFilterAgentTypes: [] })
  store.getState().hydratePersistedUI(unfiltered, 'startup')
  store.getState().setAgentsFilterAgentTypes(['codex'])
  store.getState().hydratePersistedUI(unfiltered, 'sync')
  expect(store.getState().agentsFilterAgentTypes).toEqual(['codex'])

  store.getState().notePersistedUIWriteStarted(['agentsFilterAgentTypes'])
  store.getState().setAgentsFilterAgentTypes([])
  store
    .getState()
    .hydratePersistedUI(makePersistedUI({ agentsFilterAgentTypes: ['codex'] }), 'sync')
  expect(store.getState().agentsFilterAgentTypes).toEqual([])
})
