import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import type { TerminalExitRecord } from '../../../../shared/terminal-surface-exit'
import { createTerminalPaneCreatedHandler } from './terminal-pane-pane-created'
import type { PaneCreatedSetupContext } from './terminal-pane-pane-created'

const { connectPanePty } = vi.hoisted(() => ({
  connectPanePty: vi.fn(() => ({ dispose: vi.fn() }))
}))
vi.mock('./pty-connection', () => ({ connectPanePty }))
vi.mock('./terminal-pane-pane-input', () => ({ installTerminalPaneInputHandling: vi.fn() }))
vi.mock('./terminal-pane-pane-links', () => ({ installTerminalPaneLinkHandling: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

const record: TerminalExitRecord = {
  worktreeId: 'wt-1',
  leafId: LEAF_ID,
  ptyId: 'pty-dead',
  incarnationId: 'inc-dead',
  exitCode: 3,
  cause: { kind: 'exited', exitCode: 3 },
  exitedAt: 1
}

function mountPane() {
  const pane = {
    id: 7,
    leafId: LEAF_ID,
    terminal: { parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) } }
  }
  const onPaneProcessDied = vi.fn()
  const panePtyBindings = new Map<number, unknown>()
  const context = {
    deps: {
      managerRef: { current: {} },
      tabId: 'tab-1',
      settingsRef: { current: null },
      paneCwdRef: { current: new Map() },
      paneKittyKeyboardModesRef: { current: new Map() },
      replayingPanesRef: { current: new Map() },
      panePtyBindingsRef: { current: panePtyBindings }
    },
    refs: {
      osc52DisposablesRef: { current: new Map() },
      osc7DisposablesRef: { current: new Map() },
      queuedInitialCwdRef: { current: null }
    },
    ptyDeps: { cwd: '/repo', startup: null, onPaneProcessDied },
    startupWithSetupSplitWait: null,
    startup: null,
    deferredSplitHandoffs: new Map(),
    applyAppearance: vi.fn(),
    syncPaneCount: vi.fn(),
    queueResizeAll: vi.fn(),
    defaultTabCwd: '/repo'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries every member the mount path reads before and around the spawn decision; the input and link installers are mocked.
  const handler = createTerminalPaneCreatedHandler(context as unknown as PaneCreatedSetupContext)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mount path reads only id, leafId and the terminal parser from the pane.
  handler(pane as unknown as ManagedPane)
  return { onPaneProcessDied, panePtyBindings }
}

describe('mounting a leaf main kept after its exit', () => {
  beforeEach(() => {
    connectPanePty.mockClear()
    useAppStore.getState().replaceTerminalExitRecords([])
  })

  it('shows the exit and spawns nothing', () => {
    useAppStore.getState().replaceTerminalExitRecords([record])

    const { onPaneProcessDied, panePtyBindings } = mountPane()

    expect(connectPanePty).not.toHaveBeenCalled()
    expect(panePtyBindings.size).toBe(0)
    expect(onPaneProcessDied).toHaveBeenCalledWith({
      paneId: 7,
      exitCode: 3,
      reason: 'process-failed',
      startup: null
    })
  })

  it('spawns as before for a leaf with no record', () => {
    const { onPaneProcessDied, panePtyBindings } = mountPane()

    expect(connectPanePty).toHaveBeenCalledTimes(1)
    expect(panePtyBindings.size).toBe(1)
    expect(onPaneProcessDied).not.toHaveBeenCalled()
  })
})
