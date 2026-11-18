// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentChoiceControls } from './AgentChoiceControls'

afterEach(cleanup)

describe('AgentChoiceControls effort menu', () => {
  it('places a saved level the listing omits at its rank', async () => {
    render(
      <AgentChoiceControls
        agent="grok"
        value={{ options: { effort: 'medium' } }}
        liveCatalog={{
          origin: 'probe',
          fetchedAt: 1,
          models: [
            {
              id: 'grok-4.7',
              label: 'Grok 4.7',
              isDefault: true,
              efforts: [
                { value: 'high', label: 'High' },
                { value: 'low', label: 'Low' }
              ],
              defaultEffort: 'high'
            }
          ]
        }}
        layout="rows"
        onChange={() => {}}
      />
    )
    const triggers = screen.getAllByRole('button')
    await userEvent.setup().click(triggers.at(-1)!)
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'Default',
      'Low',
      'medium',
      'High'
    ])
  })
})
