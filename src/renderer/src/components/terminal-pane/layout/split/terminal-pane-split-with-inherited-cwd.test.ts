import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'

const mocks = vi.hoisted(() => ({
  settings: { terminalFocusNewSplitPane: true as boolean },
  splitWebRuntimeTerminal: vi.fn(() => false),
  isHostTabPane: vi.fn(() => false)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: mocks.settings })
  }
}))

vi.mock('@/runtime/hosted-terminals/actions/web-runtime-terminal-split', () => ({
  splitWebRuntimeTerminal: mocks.splitWebRuntimeTerminal
}))

vi.mock('@/runtime/hosted-terminals/actions/web-runtime-split-source-pty', () => ({
  isHostTabPane: mocks.isHostTabPane,
  notifyHostTabSplitRefused: vi.fn(),
  readHostPublishedSplitSourcePtyId: vi.fn(() => null)
}))

vi.mock('./resolve-split-cwd', () => ({
  resolveSplitCwd: vi.fn(() => Promise.resolve('/tmp'))
}))

vi.mock('./terminal-pane-split-completion', () => ({
  recordCreatedTerminalPaneSplit: vi.fn()
}))

import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'

function pane(): ManagedPane {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path only reads id and leafId; layout-owner sizing is off in tests.
  return {
    id: 4,
    leafId: 'leaf-1',
    terminal: { cols: 80, rows: 24 }
  } as ManagedPane
}

describe('splitTerminalPaneWithInheritedCwd', () => {
  beforeEach(() => {
    mocks.settings.terminalFocusNewSplitPane = true
    mocks.splitWebRuntimeTerminal.mockReturnValue(false)
    mocks.isHostTabPane.mockReturnValue(false)
  })

  it('asks the pane manager not to focus the new pane when Focus New Split Pane is off', () => {
    mocks.settings.terminalFocusNewSplitPane = false
    const splitPane = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the setting-off path only calls splitPane.
    const manager = { splitPane } as PaneManager

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager,
      paneTransports: new Map(),
      paneCwdMap: new Map([[4, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: pane(),
      direction: 'vertical',
      source: 'keyboard'
    })

    expect(splitPane).toHaveBeenCalledWith(4, 'vertical', {
      cwd: '/cached',
      focusNewPane: false
    })
  })
})
