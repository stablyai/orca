// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Suspense, use, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { ConfirmationDialogContext } from './confirmation-dialog-context'
import { UntitledFileRenameDialog } from './editor/UntitledFileRenameDialog'
import { QuickCommandsPane } from './settings/QuickCommandsPane'
import { useWorkspaceKanbanColumnResize } from './sidebar/use-workspace-kanban-column-resize'
import { useAddRepoCloneFlow } from './sidebar/useAddRepoCloneFlow'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function SuspendUntil({ promise }: { promise: Promise<void> }): null {
  use(promise)
  return null
}

// A sibling suspends after the adjusting render, so React discards that render and retries it.
async function renderThenDiscardUpdate(
  initial: ReactNode,
  update: ReactNode
): Promise<ReturnType<typeof render>> {
  const view = render(<Suspense fallback={null}>{initial}</Suspense>)
  let release = (): void => {}
  const suspended = new Promise<void>((resolve) => (release = resolve))
  await act(async () =>
    view.rerender(
      <Suspense fallback={null}>
        {update}
        <SuspendUntil promise={suspended} />
      </Suspense>
    )
  )
  await act(async () => {
    release()
    await vi.advanceTimersByTimeAsync(1000)
  })
  return view
}

function KanbanColumn({ width, onCommit }: { width: number; onCommit: (w: number) => void }) {
  const resize = useWorkspaceKanbanColumnResize(width, onCommit)
  return (
    <div data-testid="column" onKeyDown={resize.onColumnResizeKeyDown}>
      {resize.columnWidth}
    </div>
  )
}

it('applies a committed board column width', async () => {
  const onCommit = vi.fn()
  await renderThenDiscardUpdate(
    <KanbanColumn width={320} onCommit={onCommit} />,
    <KanbanColumn width={420} onCommit={onCommit} />
  )
  expect(screen.getByTestId('column').textContent).toBe('420')
  fireEvent.keyDown(screen.getByTestId('column'), { key: 'ArrowRight' })
  expect(onCommit).toHaveBeenLastCalledWith(440)
})

function CloneDestination({ workspaceDir }: { workspaceDir?: string }) {
  const flow = useAddRepoCloneFlow({
    step: 'clone',
    activeRuntimeEnvironmentId: null,
    workspaceDir,
    fetchWorktrees: vi.fn(),
    onGitRepoReady: vi.fn()
  })
  return <div data-testid="destination">{flow.cloneDestination}</div>
}

it('fills the clone destination once settings hydrate', async () => {
  await renderThenDiscardUpdate(
    <CloneDestination />,
    <CloneDestination workspaceDir="/home/dev/orca" />
  )
  expect(screen.getByTestId('destination').textContent).toBe('/home/dev/orca')
})

it('seeds the save-as dialog with the opened file name', async () => {
  const props = { worktreePath: '/repo', onClose: vi.fn(), onConfirm: vi.fn() }
  await renderThenDiscardUpdate(
    <UntitledFileRenameDialog {...props} open={false} currentName="Untitled-1.md" />,
    <UntitledFileRenameDialog {...props} open currentName="Untitled-2.md" />
  )
  expect(screen.queryByDisplayValue('Untitled-2')).not.toBeNull()
})

it('opens the Add dialog for a quick-command deep link', async () => {
  const settings = getDefaultSettings('/home/dev')
  const confirm = async (): Promise<boolean> => true
  await renderThenDiscardUpdate(
    <ConfirmationDialogContext value={confirm}>
      <QuickCommandsPane settings={settings} />
    </ConfirmationDialogContext>,
    <ConfirmationDialogContext value={confirm}>
      <QuickCommandsPane settings={settings} addCommandIntentSignal={1} />
    </ConfirmationDialogContext>
  )
  expect(screen.queryByText('Add Quick Command')).not.toBeNull()
})
