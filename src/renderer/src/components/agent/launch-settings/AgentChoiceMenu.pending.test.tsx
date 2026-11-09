// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentChoiceMenu } from './AgentChoiceMenu'

afterEach(cleanup)

it('keeps pending demand reachable and the saved model visible without allowing unproven picks', async () => {
  const changed = vi.fn()
  const opened = vi.fn()
  render(
    <AgentChoiceMenu
      label="Model"
      value="saved-model"
      pendingLabel="saved-model"
      choices={[
        { value: '__agent_default__', label: 'Agent default' },
        { value: 'saved-model', label: 'saved-model' }
      ]}
      row
      onChange={changed}
      onOpenChange={opened}
    />
  )
  const trigger = screen.getByRole('button', { name: 'Model: saved-model' })
  expect(trigger.hasAttribute('disabled')).toBe(false)
  expect(trigger.getAttribute('aria-busy')).toBe('true')
  await userEvent.setup().click(trigger)
  expect(opened).toHaveBeenCalledWith(true)
  const choice = screen.getByRole('menuitemradio', { name: 'Agent default' })
  expect(choice.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(choice)
  expect(changed).not.toHaveBeenCalled()
})
