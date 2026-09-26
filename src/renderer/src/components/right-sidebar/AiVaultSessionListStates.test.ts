import { expect, it } from 'vitest'
import { aiVaultEmptyListTitle } from './AiVaultSessionListStates'

// Why: "No sessions match the current filters" told a user whose workspace
// simply has no agent history to go loosen filters that were hiding nothing.
it('names the empty scope instead of blaming the filters', () => {
  expect(
    aiVaultEmptyListTitle({
      noAgentsSelected: false,
      scopedSessionsCount: 0,
      vaultScope: 'workspace'
    })
  ).toBe('No sessions in this workspace')
  expect(
    aiVaultEmptyListTitle({
      noAgentsSelected: false,
      scopedSessionsCount: 0,
      vaultScope: 'project'
    })
  ).toBe('No sessions in this project')
})

it('blames the filters only when the scope does hold sessions', () => {
  expect(
    aiVaultEmptyListTitle({
      noAgentsSelected: false,
      scopedSessionsCount: 4,
      vaultScope: 'workspace'
    })
  ).toBe('No sessions match the current filters')
  expect(
    aiVaultEmptyListTitle({ noAgentsSelected: false, scopedSessionsCount: 0, vaultScope: 'all' })
  ).toBe('No sessions match the current filters')
})

it('reports an empty agent selection ahead of any scope answer', () => {
  expect(
    aiVaultEmptyListTitle({
      noAgentsSelected: true,
      scopedSessionsCount: 0,
      vaultScope: 'workspace'
    })
  ).toBe('No agents selected')
})
