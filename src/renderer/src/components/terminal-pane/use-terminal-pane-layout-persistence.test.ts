// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useTerminalPaneLayoutPersistence } from './use-terminal-pane-layout-persistence'

const store = vi.hoisted(
  (): { terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> } => ({
    terminalLayoutsByTabId: {}
  })
)

vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/runtime/web-runtime-session', () => ({ clearWebRuntimeTerminalBuffer: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))
vi.mock('@/lib/pane-manager/terminal-scrollback-clear', () => ({
  clearTerminalScrollbackAndFollowOutput: vi.fn()
}))

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function createPersistence() {
  const container = document.createElement('div')
  const split = document.createElement('div')
  split.className = 'pane-split'
  for (const leafId of [LEFT, RIGHT]) {
    const pane = document.createElement('div')
    pane.className = 'pane'
    pane.dataset.leafId = leafId
    split.append(pane)
  }
  container.append(split)
  const panes = [
    { id: 1, leafId: LEFT },
    { id: 2, leafId: RIGHT }
  ]
  const manager = {
    getActivePane: () => panes[1],
    getPanes: () => panes,
    getLeafIdMap: () => new Map(panes.map((pane) => [pane.id, pane.leafId]))
  }
  const transports = new Map<number, { getPtyId: () => string }>([
    [1, { getPtyId: () => 'pty-left' }]
  ])
  const controller = {
    tabId: 'terminal-1',
    worktreeId: 'workspace-1',
    containerRef: { current: container },
    managerRef: { current: manager },
    expandedPaneIdRef: { current: null },
    paneTransportsRef: { current: transports },
    clearedScrollbackLeafIdsRef: { current: new Set() },
    removedTitleLeafIdsRef: { current: new Set() },
    paneTitlesRef: { current: {} },
    remotePaneLayoutPusherRef: { current: null },
    setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot) => {
      store.terminalLayoutsByTabId[tabId] = layout
    },
    setPaneTitles: vi.fn(),
    paneTitles: {},
    paneCount: 2,
    savedLayout: undefined,
    terminalTab: undefined
  }
  const { result } = renderHook(() =>
    useTerminalPaneLayoutPersistence(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the fields read by this hook; title effects exit without a terminal tab.
      controller as unknown as Parameters<typeof useTerminalPaneLayoutPersistence>[0]
    )
  )
  return { persistLayoutSnapshot: result.current.persistLayoutSnapshot }
}

describe('live split-pane focus persistence', () => {
  afterEach(cleanup)
  beforeEach(() => {
    store.terminalLayoutsByTabId = {}
  })

  it('remembers the selected right pane while its shell is still starting', () => {
    const { persistLayoutSnapshot } = createPersistence()

    persistLayoutSnapshot()

    expect(store.terminalLayoutsByTabId['terminal-1'].activeLeafId).toBe(RIGHT)
    expect(store.terminalLayoutsByTabId['terminal-1'].ptyIdsByLeafId).toEqual({
      [LEFT]: 'pty-left'
    })
  })

  it('preserves the saved selection when only the shell binding is updated', () => {
    const { persistLayoutSnapshot } = createPersistence()
    persistLayoutSnapshot()
    const layout = store.terminalLayoutsByTabId['terminal-1']
    store.terminalLayoutsByTabId['terminal-1'] = {
      ...layout,
      ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [RIGHT]: 'pty-right' }
    }

    expect(store.terminalLayoutsByTabId['terminal-1'].activeLeafId).toBe(RIGHT)
  })
})
