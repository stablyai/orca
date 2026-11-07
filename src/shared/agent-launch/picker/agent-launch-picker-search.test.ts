import { expect, it } from 'vitest'
import { searchAgentPickerSetups } from './agent-launch-picker-search'
import type { AgentPickerEntry } from './agent-launch-picker'

it('searches the fallback models the submenu offers while the host catalog is unknown', () => {
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

  const setups = searchAgentPickerSetups([codex], 'gpt')

  expect(setups.length).toBeGreaterThan(0)
  expect(setups.every((setup) => setup.model.id.startsWith('gpt'))).toBe(true)
})
