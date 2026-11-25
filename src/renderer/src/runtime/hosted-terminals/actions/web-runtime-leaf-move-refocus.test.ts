// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StoreView = {
  activeView: string
  activeWorktreeId: string
  activeTabType: string
  activeTabId: string | null
  activeGroupIdByWorktree: Record<string, string>
  unifiedTabsByWorktree: Record<string, never[]>
}
const store = vi.hoisted(() => {
  const view: StoreView = {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/wt',
    activeTabType: 'terminal',
    activeTabId: null,
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  }
  return {
    ...view,
    runtimeStatusByEnvironmentId: new Map<string, { status: { runtimeId: string } | null }>(),
    transferAgentPaneAuthority: vi.fn(),
    closeTab: vi.fn()
  }
})
const refresh = vi.hoisted(() => ({ during: (): void => {} }))

vi.mock('../../../store/index', () => ({ useAppStore: { getState: () => store } }))
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => refresh.during())
}))
vi.mock('../../rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 1
}))
vi.mock('../../../lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => 'env-1'
}))

// The real focus scheduler: one pending focus at a time, delivered two frames later.
const { focusTerminalTabSurface } =
  await import('../../../components/terminal-pane/input/focus/focus-terminal-tab-surface')
const { settleHostPaneMove } = await import('./web-runtime-leaf-move')

const WT = 'repo::/wt'
const LEAF = '11111111-1111-4111-8111-111111111111'
const REQUEST = {
  worktreeId: WT,
  sourceTabId: 'source-tab',
  targetTabId: 'drawn-tab',
  leafId: LEAF,
  ptyId: 'pty-1'
}
const AUTHORITY = {
  environmentId: 'env-1',
  pairingRevision: 1,
  runtimeId: 'runtime-1',
  worktreeId: WT
}

describe('focus after a refused pane move', () => {
  let frames: FrameRequestCallback[]

  function terminalInput(tabId: string): HTMLTextAreaElement {
    const tab = document.createElement('div')
    tab.setAttribute('data-terminal-tab-id', tabId)
    const leaf = document.createElement('div')
    leaf.setAttribute('data-leaf-id', LEAF)
    const input = document.createElement('textarea')
    input.className = 'xterm-helper-textarea'
    leaf.appendChild(input)
    tab.appendChild(leaf)
    document.body.appendChild(tab)
    return input
  }

  function flushFrames(): void {
    for (let guard = 0; guard < 10 && frames.length > 0; guard += 1) {
      frames.shift()!(0)
    }
  }

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {}
    })
    store.activeTabId = 'drawn-tab'
    // Closing the drawn tab leaves the user on its source.
    store.closeTab.mockImplementation(() => {
      store.activeTabId = 'source-tab'
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
    refresh.during = () => {}
  })

  it('leaves alone the focus of a tab the user activated while the host was asked', async () => {
    terminalInput('source-tab')
    const other = terminalInput('other-tab')
    refresh.during = () => {
      // The user activates another terminal tab: activation selects it and asks for its focus.
      store.activeTabId = 'other-tab'
      focusTerminalTabSurface('other-tab', LEAF)
    }

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true)
    flushFrames()

    expect(document.activeElement).toBe(other)
  })

  it('gives the pane back its focus when the user stayed on its tab', async () => {
    const source = terminalInput('source-tab')

    await settleHostPaneMove(AUTHORITY, REQUEST, 'refused', true)
    flushFrames()

    expect(document.activeElement).toBe(source)
  })
})
