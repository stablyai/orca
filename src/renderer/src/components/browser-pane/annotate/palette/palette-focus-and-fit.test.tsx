// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { returnFocusAfterNotesClose } from './palette-focus-and-fit'
afterEach(() => cleanup())
describe('annotation notes focus', () => {
  it('focus helper: returns focus to the note count unless a text field has it', () => {
    render(
      <div>
        <button type="button" data-browser-annotate-notes-chip="">
          3 notes
        </button>
        <button type="button">Copy</button>
      </div>
    )
    screen.getByRole('button', { name: 'Copy' }).focus()

    returnFocusAfterNotesClose(document.body)

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '3 notes' }))
  })
})
