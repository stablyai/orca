import { describe, expect, it } from 'vitest'
import { discoveredModel } from './structured-agent-session-discovered-model'

const unconfirmed = {
  id: 'other',
  label: 'Other',
  isDefault: false,
  efforts: [
    { value: 'off', label: 'Off' },
    { value: 'auto', label: 'Auto' }
  ],
  effortsKnown: false as const
}

describe('unconfirmed effort menus', () => {
  it('hides them for Pi, whose menus are exact', () => {
    expect(discoveredModel(unconfirmed, false, 'pi').options).toEqual([])
  })

  it.each(['omp', 'claude', 'codex', undefined] as const)('still offers them for %s', (agent) => {
    const [effort] = discoveredModel(unconfirmed, false, agent).options
    expect(effort?.kind).toMatchObject({ type: 'select', choices: unconfirmed.efforts })
  })
})
