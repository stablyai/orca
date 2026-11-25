// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useModelPickFocusHandoff } from './use-model-pick-focus-handoff'

afterEach(cleanup)

let confirm: () => void = () => {}

function Page(): React.JSX.Element {
  const handoff = useModelPickFocusHandoff()
  const [saved, setSaved] = useState(false)
  confirm = () => setSaved(true)
  return (
    <div>
      {saved ? (
        <div role="status" tabIndex={-1} ref={handoff.takeFocus}>
          Saved
        </div>
      ) : (
        <button type="button" data-automation-model-picker="" onClick={handoff.arm}>
          Picker
        </button>
      )}
      <button type="button">Rerun</button>
      <p>Output</p>
    </div>
  )
}

function pickThenWait(): HTMLElement {
  render(<Page />)
  const picker = screen.getByRole('button', { name: 'Picker' })
  picker.focus()
  fireEvent.pointerDown(picker)
  fireEvent.click(picker)
  return picker
}

it('moves focus to the confirmation when the user stayed with the picker', () => {
  pickThenWait()
  act(() => confirm())
  expect(document.activeElement).toBe(screen.getByRole('status'))
})

it('leaves focus where the user moved it before the confirmation', () => {
  pickThenWait()
  const rerun = screen.getByRole('button', { name: 'Rerun' })
  act(() => rerun.focus())
  act(() => confirm())
  expect(document.activeElement).toBe(rerun)
})

it('does not take focus after the user clicked other content', () => {
  const picker = pickThenWait()
  fireEvent.pointerDown(screen.getByText('Output'))
  act(() => picker.blur())
  expect(document.activeElement).toBe(document.body)
  act(() => confirm())
  expect(document.activeElement).toBe(document.body)
})
