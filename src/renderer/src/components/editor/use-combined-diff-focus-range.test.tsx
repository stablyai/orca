// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useCombinedDiffFocusRange } from './use-combined-diff-focus-range'
import { createCombinedDiffOverflow } from './combined-diff-overflow'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

it('retains only the focused owner, including overflow focus, and isolates hosts and standalone editors', () => {
  const viewport = document.createElement('div')
  const other = document.createElement('div')
  const standalone = document.createElement('input')
  const row = document.createElement('div')
  row.dataset.combinedDiffSectionRow = ''
  row.dataset.index = '8'
  const input = document.createElement('input')
  row.append(input)
  viewport.append(row)
  document.body.append(viewport, other, standalone)
  const ref = createRef<HTMLDivElement>()
  ref.current = viewport
  const otherRef = createRef<HTMLDivElement>()
  otherRef.current = other
  function Probe({ second = false }: { second?: boolean }) {
    const extract = useCombinedDiffFocusRange(second ? otherRef : ref)
    return (
      <output data-testid={second ? 'other' : 'owner'}>
        {extract({ startIndex: 0, endIndex: 1, count: 12, overscan: 0 }).join(',')}
      </output>
    )
  }
  const view = render(
    <>
      <Probe />
      <Probe second />
    </>
  )
  act(() => input.focus())
  expect(view.getByTestId('owner').textContent).toBe('0,1,8')
  expect(view.getByTestId('other').textContent).toBe('0,1')
  const overflow = createCombinedDiffOverflow(viewport, row)
  const widgetInput = document.createElement('input')
  overflow.node.append(widgetInput)
  act(() => widgetInput.focus())
  expect(view.getByTestId('owner').textContent).toBe('0,1,8')
  row.dataset.index = '9'
  view.rerender(
    <>
      <Probe />
      <Probe second />
    </>
  )
  expect(view.getByTestId('owner').textContent).toBe('0,1,9')
  act(() => standalone.focus())
  expect(view.getByTestId('owner').textContent).toBe('0,1')
  overflow.dispose()
  expect(widgetInput.isConnected).toBe(false)
})
