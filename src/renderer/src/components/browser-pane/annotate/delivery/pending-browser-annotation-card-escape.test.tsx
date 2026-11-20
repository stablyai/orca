// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import {
  interceptAnnotateEscape,
  registerAnnotateEscapeInterceptor
} from '../palette/annotate-escape-interceptor'
import { returnFocusAfterNotesClose } from '../palette/palette-focus-and-fit'
import { PendingBrowserAnnotationCard } from './pending-browser-annotation-card'

const PAGE_ID = 'page-1'
const payload = { ...makeAnnotation(PAGE_ID).payload, screenshot: null }

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
})
afterEach(() => cleanup())

/**
 * The real card with the real interceptor registry and focus helper; the notes list itself is a stand-in (this does not
 * render the production overlays; that path is proven in the isolated build).
 */
function Harness(): React.JSX.Element {
  const [notesOpen, setNotesOpen] = useState(true)
  const [cardOpen, setCardOpen] = useState(true)
  useEffect(() => {
    if (!notesOpen) {
      return
    }
    // In the app React commits the list closing, and so removes this interceptor, between the card layer's Esc
    // listener (document capture) and the textarea's (bubble). The test environment batches both listeners into one
    // update, so the interceptor removes itself here to give the same order deterministically.
    const unregister = registerAnnotateEscapeInterceptor(PAGE_ID, () => {
      unregister()
      setNotesOpen(false)
      returnFocusAfterNotesClose(document.body)
      return true
    })
    return unregister
  }, [notesOpen])
  return (
    <div>
      <button type="button" data-browser-annotate-notes-chip="">
        3 notes
      </button>
      {notesOpen ? <div data-testid="notes">3 notes</div> : null}
      {cardOpen ? (
        <PendingBrowserAnnotationCard
          payload={payload}
          worktreeId="worktree-1"
          resolveAnchor={() => ({ x: 10, y: 10, side: 'bottom' })}
          portalContainer={null}
          onAdd={() => {}}
          onCancel={() => setCardOpen(false)}
          onEscape={() => interceptAnnotateEscape(PAGE_ID)}
        />
      ) : null}
    </div>
  )
}

describe('the comment card handles one Esc once', () => {
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

  it('one Esc seen by both the card layer and its text field acts once: it is taken by the registered interceptor, and the field keeps focus', async () => {
    render(<Harness />)
    const textarea = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })
    })
    expect(screen.queryByTestId('notes')).toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeNull()
    // The comment being written keeps focus; it doesn't jump to the note count.
    expect(document.activeElement).toBe(screen.getByRole('textbox'))

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', code: 'Escape' })
    })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
