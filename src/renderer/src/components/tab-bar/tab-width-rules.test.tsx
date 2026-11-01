// @vitest-environment happy-dom

import { Suspense, useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TabTitleLabel, TabTitleWidthProvider, type TabTitleRename } from './tab-width-rules'
import { useTabStripSlotProps } from './use-tab-strip-slot-props'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { experimentalFitTabsToTitles: true }, activeWorktreeId: 'workspace' })
}))
vi.mock('../tab-group/tab-drag-context', () => ({ useTabDragActive: () => false }))

type TabProps = {
  title: string
  savedName?: string | null
  editing?: boolean
  rename?: TabTitleRename
  suspend?: boolean
}
const never = new Promise<void>(() => {})
function Tab({ title, savedName = title, editing, rename, suspend }: TabProps) {
  const slotProps = useTabStripSlotProps('a', true, { savedName, editing, rename })
  if (suspend) {
    throw never
  }
  return (
    <div {...slotProps} data-testid="slot">
      <div data-tab-id="a">
        {editing ? <input defaultValue={title} /> : <TabTitleLabel title={title} />}
      </div>
    </div>
  )
}

function Strip({
  shown = true,
  open = true,
  ...tab
}: TabProps & { shown?: boolean; open?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref}>
      <TabTitleWidthProvider worktreeId="workspace" shown={shown} tabIds={open ? ['a'] : []}>
        <Suspense fallback={<span>Loading</span>}>{open && <Tab {...tab} />}</Suspense>
      </TabTitleWidthProvider>
    </div>
  )
}

let naturalWidth = 200
beforeEach(() => {
  vi.useFakeTimers()
  naturalWidth = 200
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(0, 0, 100, 32)], { item: () => null })
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, naturalWidth, 32)
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('holds the entire tab width through title churn and quiet periods without remeasuring', () => {
  const view = render(<Strip title="Initial" />)
  const slot = view.getByTestId('slot')
  expect(slot.style.maxWidth).toBe('200px')
  const measurements = vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length
  naturalWidth = 500
  view.rerender(<Strip title="AI generated title" />)
  act(() => vi.advanceTimersByTime(60_000))
  view.rerender(<Strip title="Another AI title" />)
  expect(view.getByText('Another AI title')).toBeTruthy()
  expect(slot.style.maxWidth).toBe('200px')
  expect(HTMLElement.prototype.getBoundingClientRect).toHaveBeenCalledTimes(measurements)
})

it('refits when the workspace returns, using the latest content', () => {
  const view = render(<Strip title="Initial" />)
  view.rerender(<Strip title="Updated" shown={false} />)
  naturalWidth = 400
  view.rerender(<Strip title="Updated" />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('400px')
})

it('holds width while editing and cancelling, then refits an acknowledged user rename', () => {
  const view = render(<Strip title="Initial" />)
  naturalWidth = 120
  view.rerender(<Strip title="Initial" editing />)
  view.rerender(<Strip title="Initial" />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('200px')
  // A remote rename can commit before its title is republished by the host.
  view.rerender(<Strip title="Initial" rename={{ count: 1, title: 'User name' }} />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('200px')
  naturalWidth = 350
  view.rerender(<Strip title="User name" rename={{ count: 1, title: 'User name' }} />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('350px')
  naturalWidth = 500
  view.rerender(<Strip title="AI title" rename={{ count: 1, title: 'User name' }} />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('350px')
})

it('forgets closed tabs and does not publish measurements from a suspended render', () => {
  const view = render(<Strip title="Initial" />)
  view.rerender(<Strip title="Initial" open={false} />)
  naturalWidth = 450
  view.rerender(<Strip title="Uncommitted" suspend />)
  naturalWidth = 300
  view.rerender(<Strip title="Reopened" />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('300px')
})

it('does not treat later AI titles as acknowledgements after clearing a custom name', () => {
  const view = render(<Strip title="Name" savedName="Name" />)
  naturalWidth = 300
  view.rerender(<Strip title="Name" savedName={null} rename={{ count: 1, title: null }} />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('300px')
  naturalWidth = 500
  view.rerender(<Strip title="AI name" savedName={null} rename={{ count: 1, title: null }} />)
  expect(view.getByTestId('slot').style.maxWidth).toBe('300px')
})
