// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPaneCover } from './NativeChatPaneCover'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('reports chat focus to main, including the focus it takes from its terminal on mount', () => {
  const setNativeChatCoverFocused = vi.fn()
  vi.stubGlobal('api', { ui: { setNativeChatCoverFocused } })
  const terminalElement = document.body.appendChild(document.createElement('div'))
  terminalElement.appendChild(document.createElement('textarea')).focus()
  const pane = {
    container: document.createElement('div'),
    terminal: { element: terminalElement, focus: vi.fn() }
  }
  render(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cover reads only the xterm element and focus.
    <NativeChatPaneCover pane={pane as never}>
      <textarea aria-label="composer" />
    </NativeChatPaneCover>
  )
  expect(setNativeChatCoverFocused).toHaveBeenLastCalledWith(true)

  document.body.appendChild(document.createElement('button')).focus()
  expect(setNativeChatCoverFocused).toHaveBeenLastCalledWith(false)

  screen.getByLabelText('composer').focus()
  expect(setNativeChatCoverFocused).toHaveBeenLastCalledWith(true)
})

it("clears main's chat focus only from the cover that had it", () => {
  const setNativeChatCoverFocused = vi.fn()
  vi.stubGlobal('api', { ui: { setNativeChatCoverFocused } })
  const renderCover = (label: string) => {
    const pane = {
      container: document.createElement('div'),
      terminal: { element: document.createElement('div'), focus: vi.fn() }
    }
    return render(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cover reads only the xterm element and focus.
      <NativeChatPaneCover pane={pane as never}>
        <textarea aria-label={label} />
      </NativeChatPaneCover>
    )
  }
  const first = renderCover('first composer')
  const second = renderCover('second composer')

  screen.getByLabelText('first composer').focus()
  screen.getByLabelText('second composer').focus()
  first.unmount()
  expect(setNativeChatCoverFocused).toHaveBeenLastCalledWith(true)

  second.unmount()
  expect(setNativeChatCoverFocused).toHaveBeenLastCalledWith(false)
})
