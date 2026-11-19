// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAnnotation } from '@/store/slices/browser/annotations/browser-annotation-test-fixture'
import {
  interceptAnnotateEscape,
  registerAnnotateEscapeInterceptor
} from '../palette/annotate-escape-interceptor'
import { PendingBrowserAnnotationCard } from './pending-browser-annotation-card'

const PAGE_ID = 'page-1'
const payload = { ...makeAnnotation(PAGE_ID).payload, screenshot: null }

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: {} })
})
afterEach(() => cleanup())

/** The mode as the overlays wire it: an open notes list registers to take Esc first; the card asks it. */
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
      return true
    })
    return unregister
  }, [notesOpen])
  return (
    <div>
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

describe('Esc in the comment card with the notes list open', () => {
  it('closes only the notes list on the first Esc, and the card on the next', async () => {
    render(<Harness />)
    const textarea = await screen.findByRole('textbox')

    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' })
    })
    expect(screen.queryByTestId('notes')).toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeNull()

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', code: 'Escape' })
    })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
