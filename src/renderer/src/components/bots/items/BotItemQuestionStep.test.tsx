// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BotItemChipWords, botItemChipTitle } from './BotItemQuestionStep'

afterEach(cleanup)

const reply = { label: 'I rotated it; purge the transcript', recommended: true }

it('names the filled chip Recommended without showing the word', () => {
  render(
    <button type="button">
      <BotItemChipWords reply={reply} filled />
    </button>
  )
  // The test DOM pads inline boundaries with a space; a browser reads "…transcript, Recommended".
  const chip = screen.getByRole('button', {
    name: /^I rotated it; purge the transcript ?, Recommended$/
  })
  expect(chip.querySelector('.sr-only')?.textContent).toBe(', Recommended')
  expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe('★')
})

it('puts Recommended over the reply detail in the tooltip', () => {
  expect(botItemChipTitle(reply, 'Recommended')).toBe('Recommended')
  expect(botItemChipTitle({ ...reply, detail: 'Then close it' }, 'Recommended')).toBe(
    'Recommended\nThen close it'
  )
  expect(botItemChipTitle({ label: 'Wait', recommended: false }, null)).toBeUndefined()
})
