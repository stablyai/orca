// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusPaneIfFocusUnclaimed } from './pane-overlay-focus'

afterEach(() => {
  document.body.replaceChildren()
})

function createPaneFixture() {
  const container = document.createElement('div')
  const textarea = document.createElement('textarea')
  container.append(textarea)
  document.body.append(container)
  const focus = vi.fn(() => textarea.focus())
  return { container, textarea, focus, pane: { container, terminal: { focus } } }
}

describe('focusPaneIfFocusUnclaimed', () => {
  it('focuses the pane when focus fell to body', () => {
    const f = createPaneFixture()
    focusPaneIfFocusUnclaimed(f.pane)
    expect(document.activeElement).toBe(f.textarea)
    expect(f.focus).toHaveBeenCalledOnce()
  })

  it('keeps focus on a control the user moved to', () => {
    const f = createPaneFixture()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    focusPaneIfFocusUnclaimed(f.pane)

    expect(document.activeElement).toBe(input)
    expect(f.focus).not.toHaveBeenCalled()
  })

  it('does not steal focus when a dialog overlay owns focus', () => {
    const f = createPaneFixture()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)

    focusPaneIfFocusUnclaimed(f.pane)

    expect(f.focus).not.toHaveBeenCalled()
  })
})
