// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useKeptMathSelection } from './use-kept-math-selection'

afterEach(cleanup)

const SOURCE = '$$\na^2 + b^2 = c^2\n$$'

/** A streaming reply whose redraw remounts its equation's element (a new key), as a block redraw can. */
function Reply({ redraw, tail }: { redraw: number; tail: string }): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  useKeptMathSelection(root, true)
  return (
    <div ref={root}>
      <span key={redraw} data-math-source={SOURCE}>
        <span className="katex-display">a² + b² = c²</span>
      </span>
      <p>{tail}</p>
    </div>
  )
}

it('selects the replacement of a selected equation a redraw replaced', () => {
  const view = render(<Reply redraw={0} tail="Here" />)
  const before = view.container.querySelector('.katex-display')!
  act(() => {
    const range = document.createRange()
    range.selectNodeContents(before)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  view.rerender(<Reply redraw={1} tail="Here more" />)
  const after = view.container.querySelector(`[data-math-source]`)!
  expect(before.isConnected).toBe(false)
  const range = document.getSelection()!.getRangeAt(0)
  expect(after.contains(range.commonAncestorContainer)).toBe(true)
  expect(document.getSelection()!.toString()).toContain('a² + b² = c²')
})
