import { beforeEach, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { splitPaneInMain } from './terminal-pane-split-in-main'
import { runBootstrapSplitInMain } from './terminal-pane-bootstrap-split-in-main'

const mocks = vi.hoisted(() => ({
  splitPaneInMain: vi.fn<typeof splitPaneInMain>(),
  runTerminalPaneBootstrapSplits: vi.fn()
}))
vi.mock('./terminal-pane-split-in-main', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  splitPaneInMain: mocks.splitPaneInMain
}))
vi.mock('./terminal-pane-mount-bootstrap', () => ({
  runTerminalPaneBootstrapSplits: mocks.runTerminalPaneBootstrapSplits
}))

const SOURCE = '11111111-1111-4111-8111-111111111111'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup split reads only the target pane.
const manager = {
  getActivePane: () => ({ id: 1, leafId: SOURCE, terminal: { cols: 120, rows: 30 } }),
  getPanes: () => [{ id: 1, leafId: SOURCE, terminal: { cols: 120, rows: 30 } }]
} as unknown as PaneManager
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: passed through to today's split only.
const ptyDeps = {} as PtyConnectionDeps
const issue = { command: 'issue runner', env: { ISSUE: '42' } }

beforeEach(() => {
  mocks.splitPaneInMain.mockReset()
  mocks.runTerminalPaneBootstrapSplits.mockReset()
})

function run(): void {
  runBootstrapSplitInMain({
    manager,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    ptyDeps,
    issueCommandSplit: issue,
    isActive: true
  })
}

it('asks main to split the tab and start its startup command at half the source pane, keeping focus there', () => {
  mocks.splitPaneInMain.mockReturnValue(true)

  run()

  expect(mocks.splitPaneInMain).toHaveBeenCalledWith(
    {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      sourceLeafId: SOURCE,
      direction: 'vertical',
      initialSize: { cols: 60, rows: 30 },
      keepSourceFocused: true,
      command: 'issue runner',
      env: { ISSUE: '42' }
    },
    expect.any(Function)
  )
  expect(mocks.runTerminalPaneBootstrapSplits).not.toHaveBeenCalled()
})

it('splits as today where main does not own the tab', () => {
  mocks.splitPaneInMain.mockReturnValue(false)

  run()

  expect(mocks.runTerminalPaneBootstrapSplits).toHaveBeenCalledWith({
    manager,
    ptyDeps,
    issueCommandSplit: issue,
    isActive: true
  })
})

it('splits as today when main answers that a paired server holds the tab', () => {
  mocks.splitPaneInMain.mockReturnValue(true)

  run()
  mocks.splitPaneInMain.mock.calls[0]![1]()

  expect(mocks.runTerminalPaneBootstrapSplits).toHaveBeenCalledTimes(1)
})
