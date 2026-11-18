// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AutomationProjectCombobox from './AutomationProjectCombobox'

const bots = [
  { id: 'bot-1', hostId: 'local' as const, name: 'Reviewer', avatar: '🦉' },
  { id: 'bot-2', hostId: 'local' as const, name: 'Scout', avatar: null }
]

afterEach(cleanup)

describe('AutomationProjectCombobox bots', () => {
  it('shows each bot’s avatar beside its option and on the selected value', () => {
    render(
      <AutomationProjectCombobox
        repos={[]}
        value=""
        onValueChange={vi.fn()}
        bots={bots}
        selectedBotId="bot-1"
        onBotChange={vi.fn()}
      />
    )
    const trigger = screen.getByRole('combobox')
    expect(within(trigger).getByText('🦉')).toBeTruthy()
    expect(trigger.textContent).toContain('Reviewer')

    fireEvent.click(trigger)
    const scout = screen.getByRole('button', { name: /Scout/ })
    // A bot without an emoji shows its initial.
    expect(within(scout).getByText('S')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Reviewer/ })).getByText('🦉')).toBeTruthy()
  })
})
