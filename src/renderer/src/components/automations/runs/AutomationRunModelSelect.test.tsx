// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { AutomationRunModelSelect } from './AutomationRunModelPicker'
import type { AutomationRunModelOption } from './automation-run-model-fix'

afterEach(cleanup)

const OPTIONS = [
  { id: 'model-beta', label: 'Model Beta' },
  { id: 'model-gamma', label: 'Model Gamma' },
  { id: 'model-delta', label: 'Model Delta' }
]

/** Mirrors the run page: a pick sets pending until its save settles. The first save is held; any
 *  later one settles at once, as a prompt "already in progress" reply would (simulated). */
function Harness({ onPick }: { onPick: (option: AutomationRunModelOption) => void }) {
  const [pending, setPending] = useState(false)
  const [picks, setPicks] = useState(0)
  return (
    <AutomationRunModelSelect
      options={OPTIONS}
      currentModel="model-beta"
      disabled={false}
      busy={pending}
      onPick={(option) => {
        onPick(option)
        setPending(true)
        const save =
          picks === 0 ? new Promise<void>((resolve) => (releaseFirst = resolve)) : Promise.resolve()
        setPicks((count) => count + 1)
        void save.finally(() => setPending(false))
      }}
    />
  )
}

let releaseFirst: () => void = () => {}

function type(trigger: HTMLElement, text: string): void {
  for (const key of text) {
    fireEvent.keyDown(trigger, { key })
  }
}

it('picks by a typed letter on an idle closed trigger without opening it', () => {
  const onPick = vi.fn()
  render(<Harness onPick={onPick} />)
  const trigger = screen.getByRole('combobox')
  trigger.focus()
  // One letter: Radix picks the next match after the current model.
  type(trigger, 'M')
  expect(onPick).toHaveBeenCalledTimes(1)
  expect(onPick).toHaveBeenCalledWith({ id: 'model-gamma', label: 'Model Gamma' })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

it('ignores typing and open keys while a pick is saving, keeps it pending, and lets Tab through', async () => {
  const onPick = vi.fn()
  render(<Harness onPick={onPick} />)
  const trigger = screen.getByRole('combobox')
  trigger.focus()
  type(trigger, 'M')
  expect(onPick).toHaveBeenCalledTimes(1)
  expect(trigger.getAttribute('aria-disabled')).toBe('true')

  // Wait out the typeahead window so the next letters start a new search.
  await act(() => new Promise((resolve) => setTimeout(resolve, 1100)))
  type(trigger, 'Model D')
  expect(fireEvent.keyDown(trigger, { key: 'Enter' })).toBe(false)
  expect(fireEvent.keyDown(trigger, { key: 'ArrowDown' })).toBe(false)
  await act(async () => {})

  expect(onPick).toHaveBeenCalledTimes(1)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  // Still pending: no second save settled early.
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(trigger)
  // Tab is not cancelled, so focus can leave the busy trigger.
  expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  expect(fireEvent.keyDown(trigger, { key: 'Tab', shiftKey: true })).toBe(true)

  await act(async () => releaseFirst())
  expect(trigger.getAttribute('aria-disabled')).toBeNull()
})
