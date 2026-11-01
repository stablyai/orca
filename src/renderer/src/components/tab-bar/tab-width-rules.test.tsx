// @vitest-environment happy-dom

import { useRef } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TabTitleLabel, TabTitleWidthProvider } from './tab-width-rules'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { experimentalFitTabsToTitles: true }, activeWorktreeId: 'workspace' })
}))

const NO_HIDDEN_LABELS: string[] = []

function Strip({
  titles,
  tabIds = Object.keys(titles),
  hiddenLabels = NO_HIDDEN_LABELS,
  liveTitle
}: {
  titles: Record<string, string>
  tabIds?: string[]
  hiddenLabels?: string[]
  liveTitle?: string
}) {
  const stripRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={stripRef} data-testid="strip">
      <TabTitleWidthProvider worktreeId="workspace" stripRef={stripRef} tabIds={tabIds}>
        {tabIds
          .filter((id) => !hiddenLabels.includes(id))
          .map((id) => (
            <TabTitleLabel key={id} tabId={id} title={titles[id]} liveTitle={liveTitle} />
          ))}
      </TabTitleWidthProvider>
    </div>
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('restarts strip quiet time when a title returns to its held value', () => {
  const view = render(<Strip titles={{ a: 'A', b: 'B' }} />)
  view.rerender(<Strip titles={{ a: 'Changed A', b: 'Changed B' }} />)
  act(() => vi.advanceTimersByTime(2900))
  view.rerender(<Strip titles={{ a: 'A', b: 'Changed B' }} />)
  act(() => vi.advanceTimersByTime(100))
  expect(view.getByText('Changed B').parentElement?.getAttribute('data-settled-title')).toBe('B')
  act(() => vi.advanceTimersByTime(2900))
  expect(view.container.querySelector('[data-settled-title]')).toBeNull()
})

it('counts live terminal changes as activity while displaying a custom name', () => {
  const view = render(<Strip titles={{ a: 'Custom', b: 'B' }} liveTitle="shell" />)
  view.rerender(<Strip titles={{ a: 'Custom', b: 'Changed B' }} liveTitle="shell" />)
  act(() => vi.advanceTimersByTime(2900))
  view.rerender(<Strip titles={{ a: 'Custom', b: 'Changed B' }} liveTitle="agent" />)
  act(() => vi.advanceTimersByTime(100))
  expect(view.getByText('Custom')).toBeTruthy()
  expect(view.getByText('Changed B').parentElement?.getAttribute('data-settled-title')).toBe('B')
  act(() => vi.advanceTimersByTime(2900))
  expect(view.container.querySelector('[data-settled-title]')).toBeNull()
})

it('keeps held widths through label remounts but forgets closed tabs', () => {
  const view = render(<Strip titles={{ a: 'A' }} />)
  fireEvent.pointerEnter(view.getByTestId('strip'))
  view.rerender(<Strip titles={{ a: 'Changed' }} />)
  view.rerender(<Strip titles={{ a: 'Changed' }} hiddenLabels={['a']} />)
  view.rerender(<Strip titles={{ a: 'Changed' }} />)
  expect(view.getByText('Changed').parentElement?.getAttribute('data-settled-title')).toBe('A')
  view.rerender(<Strip titles={{}} />)
  view.rerender(<Strip titles={{ a: 'Reopened' }} />)
  expect(view.container.querySelector('[data-settled-title]')).toBeNull()
})
