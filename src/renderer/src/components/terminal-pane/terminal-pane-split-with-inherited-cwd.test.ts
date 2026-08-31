import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'

const mocks = vi.hoisted(() => ({
  recordCreatedTerminalPaneSplit: vi.fn(),
  resolveSplitCwd: vi.fn(),
  splitWebRuntimeTerminal: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  splitWebRuntimeTerminal: mocks.splitWebRuntimeTerminal
}))

vi.mock('./resolve-split-cwd', () => ({
  resolveSplitCwd: mocks.resolveSplitCwd
}))

vi.mock('./terminal-pane-split-completion', () => ({
  recordCreatedTerminalPaneSplit: mocks.recordCreatedTerminalPaneSplit
}))

function makeManager(splitPane: ReturnType<typeof vi.fn>): PaneManager {
  return { splitPane } as unknown as PaneManager
}

async function flushAsyncSplit(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('splitTerminalPaneWithInheritedCwd', () => {
  beforeEach(() => {
    mocks.recordCreatedTerminalPaneSplit.mockReset()
    mocks.resolveSplitCwd.mockReset()
    mocks.splitWebRuntimeTerminal.mockReset()
    mocks.splitWebRuntimeTerminal.mockReturnValue(false)
  })

  it.each(['keyboard', 'context_menu'] as const)(
    'delegates remote %s splits without creating a competing local pane',
    (source) => {
      const splitPane = vi.fn()
      const transport = { getPtyId: () => 'remote:web-env-1@@terminal-1' } as PtyTransport
      mocks.splitWebRuntimeTerminal.mockReturnValue(true)

      splitTerminalPaneWithInheritedCwd({
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        manager: makeManager(splitPane),
        paneTransports: new Map([[1, transport]]),
        paneCwdMap: new Map(),
        fallbackCwd: '/fallback',
        pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
        direction: 'vertical',
        source
      })

      expect(mocks.splitWebRuntimeTerminal).toHaveBeenCalledWith(
        'remote:web-env-1@@terminal-1',
        'vertical',
        source,
        { worktreeId: 'worktree-1', tabId: 'tab-1', leafId: 'leaf-1' }
      )
      expect(splitPane).not.toHaveBeenCalled()
    }
  )

  it('keeps the existing local split-and-focus path unchanged', () => {
    const createdPane = { id: 2 }
    const splitPane = vi.fn(() => createdPane)

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(splitPane),
      paneTransports: new Map(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'horizontal',
      source: 'keyboard'
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', { cwd: '/cached' })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(createdPane, {
      source: 'keyboard',
      direction: 'horizontal'
    })
  })

  it('uses the live manager after async cwd resolution', async () => {
    const staleSplitPane = vi.fn()
    const liveSplitPane = vi.fn(() => ({ id: 2 }))
    mocks.resolveSplitCwd.mockResolvedValue('/resolved')

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(staleSplitPane),
      getManager: () => makeManager(liveSplitPane),
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'vertical',
      source: 'context_menu'
    })

    await flushAsyncSplit()

    expect(staleSplitPane).not.toHaveBeenCalled()
    expect(liveSplitPane).toHaveBeenCalledWith(1, 'vertical', { cwd: '/resolved' })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(
      { id: 2 },
      { source: 'context_menu', direction: 'vertical' }
    )
  })

  it('does not split a stale manager when the live manager is gone', async () => {
    const staleSplitPane = vi.fn()
    mocks.resolveSplitCwd.mockResolvedValue('/resolved')

    splitTerminalPaneWithInheritedCwd({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      manager: makeManager(staleSplitPane),
      getManager: () => null,
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1, leafId: 'leaf-1' } as ManagedPane,
      direction: 'horizontal',
      source: 'context_menu'
    })

    await flushAsyncSplit()

    expect(staleSplitPane).not.toHaveBeenCalled()
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(undefined, {
      source: 'context_menu',
      direction: 'horizontal'
    })
  })
})
