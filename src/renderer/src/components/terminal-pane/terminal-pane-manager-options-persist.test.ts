import { describe, expect, it, vi } from 'vitest'
import { createTerminalPaneManagerOptions } from './terminal-pane-manager-options'
import type { TerminalPaneManagerOptionsContext } from './terminal-pane-mount-context'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

function createOptions(shouldPersistLayout = true) {
  const persistLayoutSnapshot = vi.fn()
  const context = {
    deps: {
      persistLayoutSnapshot,
      syncExpandedLayout: vi.fn(),
      tabId: 'tab',
      worktreeId: 'wt',
      isVisibleRef: { current: true },
      settingsRef: { current: null }
    },
    ptyDeps: {},
    syncCanExpandState: vi.fn(),
    syncPaneCount: vi.fn(),
    syncPaneLayoutRevision: vi.fn(),
    queueResizeAll: vi.fn(),
    shouldPersistLayout: () => shouldPersistLayout
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: building options and running onLayoutChanged read only these fields.
  const optionsContext = context as unknown as TerminalPaneManagerOptionsContext
  const options = createTerminalPaneManagerOptions(optionsContext)
  return { options, persistLayoutSnapshot }
}

describe('terminal pane manager layout persist wiring', () => {
  it('persists a layout change', () => {
    const { options, persistLayoutSnapshot } = createOptions()
    options.onLayoutChanged?.()
    expect(persistLayoutSnapshot).toHaveBeenCalledOnce()
  })

  it('keeps the persist gate', () => {
    const { options, persistLayoutSnapshot } = createOptions(false)
    options.onLayoutChanged?.()
    expect(persistLayoutSnapshot).not.toHaveBeenCalled()
  })
})
