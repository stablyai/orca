// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useSessionGridTerminalFocus } from './session-grid-terminal-focus'

function Card() {
  const ref = useRef<HTMLDivElement>(null)
  const focused = useSessionGridTerminalFocus(ref)
  return (
    <section data-focused={focused}>
      <button>Header action</button>
      <div ref={ref}>
        <textarea aria-label="terminal" className="xterm-helper-textarea" />
      </div>
    </section>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('terminal focus affordance', () => {
  it('follows terminal focus, not the selected card or its header controls', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const view = render(
      <>
        <Card />
        <Card />
      </>
    )
    const inputs = view.getAllByRole('textbox')
    const cards = view.container.querySelectorAll('section')
    expect(cards[0]).toHaveAttribute('data-focused', 'false')
    await act(async () => {
      inputs[0]!.focus()
    })
    expect(cards[0]).toHaveAttribute('data-focused', 'true')
    await act(async () => {
      inputs[1]!.focus()
    })
    expect(cards[0]).toHaveAttribute('data-focused', 'false')
    expect(cards[1]).toHaveAttribute('data-focused', 'true')
    await act(async () => {
      view.getAllByRole('button')[1]!.focus()
    })
    expect(cards[1]).toHaveAttribute('data-focused', 'false')
  })

  it('tracks window focus without moving the keyboard or reclaiming it', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const view = render(<Card />)
    const input = view.getByRole('textbox')
    await act(async () => {
      input.focus()
    })
    hasFocus.mockReturnValue(false)
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(view.container.querySelector('section')).toHaveAttribute('data-focused', 'false')
    expect(document.activeElement).toBe(input)
    hasFocus.mockReturnValue(true)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(view.container.querySelector('section')).toHaveAttribute('data-focused', 'true')
  })
})
