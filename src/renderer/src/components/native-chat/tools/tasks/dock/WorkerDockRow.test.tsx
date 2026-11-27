// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  NativeChatWorkerDockFrame,
  useWorkerDockStructuralValue
} from './NativeChatWorkerDockFrame'
import { WorkerDockRow, type WorkerDockRowView } from './WorkerDockRow'

afterEach(cleanup)
const running: WorkerDockRowView = {
  id: 'home/source/worker/attempt-1',
  dispatchId: 'attempt-1',
  source: 'source',
  kind: 'worker',
  name: 'Verifier',
  title: 'Review journal',
  model: null,
  state: 'running',
  changedAt: null,
  startedAt: null,
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
}
function HeldRow({
  row,
  action
}: {
  row: WorkerDockRowView
  action: (row: WorkerDockRowView, kind: 'stop' | 'clear') => void
}) {
  return (
    <WorkerDockRow
      row={useWorkerDockStructuralValue(row)}
      mixed={false}
      visible
      pending={false}
      onOpen={() => {}}
      onAction={action}
    />
  )
}
it('keeps the pressed Stop intent when that attempt fails before pointerup', () => {
  const action = vi.fn()
  const tree = (row: WorkerDockRowView) => (
    <TooltipProvider>
      <NativeChatWorkerDockFrame>
        <HeldRow row={row} action={action} />
      </NativeChatWorkerDockFrame>
    </TooltipProvider>
  )
  const { rerender } = render(tree(running))
  const target = screen.getByRole('button', { name: 'Stop Verifier · Review journal' })
  fireEvent.pointerDown(target, { button: 0, pointerId: 1 })
  rerender(tree({ ...running, state: 'failed', settlement: 'failure-1', stoppable: false }))
  expect(screen.getByRole('button', { name: 'Stop Verifier · Review journal' })).toBe(target)
  fireEvent.pointerUp(target, { pointerId: 1 })
  fireEvent.click(target)
  expect(action).toHaveBeenCalledWith(
    expect.objectContaining({ dispatchId: 'attempt-1', settlement: null }),
    'stop'
  )
})
it.each([
  ['a saving row', { ...running, state: 'saving' as const, stoppable: false }],
  ['a remote worker', { ...running, ownerActionsAvailable: false }],
  ['a failure with nothing to acknowledge', { ...running, state: 'failed' as const }],
  [
    'a remote failure',
    { ...running, state: 'failed' as const, settlement: 'failure-1', ownerActionsAvailable: false }
  ]
])('shows no Stop or Clear for %s, which has nothing it can do here', (_name, row) => {
  render(
    <TooltipProvider>
      <WorkerDockRow
        row={row}
        mixed={false}
        visible
        pending={false}
        onOpen={() => {}}
        onAction={() => {}}
      />
    </TooltipProvider>
  )
  expect(screen.queryByRole('button', { name: /^(Stop|Clear) Verifier/ })).toBeNull()
})

it('keeps a focused Stop unavailable when its accepted failure arrives', () => {
  const action = vi.fn()
  const tree = (row: WorkerDockRowView) => (
    <TooltipProvider>
      <WorkerDockRow
        row={row}
        mixed={false}
        visible
        pending={false}
        onOpen={() => {}}
        onAction={action}
      />
    </TooltipProvider>
  )
  const { rerender } = render(tree(running))
  const target = screen.getByRole('button', { name: /^Stop Verifier/ })
  act(() => target.focus())
  rerender(tree({ ...running, state: 'failed', settlement: 'failure-1', stoppable: false }))
  expect(screen.getByRole('button', { name: /^Stop Verifier/ })).toBe(target)
  expect(target).toHaveFocus()
  expect(target).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(target)
  expect(action).not.toHaveBeenCalled()
})
