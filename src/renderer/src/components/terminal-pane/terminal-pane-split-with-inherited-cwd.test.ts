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

  it('uses the live manager after async cwd resolution', async () => {
    const staleSplitPane = vi.fn()
    const liveSplitPane = vi.fn(() => ({ id: 2 }))
    mocks.resolveSplitCwd.mockResolvedValue('/resolved')

    splitTerminalPaneWithInheritedCwd({
      manager: makeManager(staleSplitPane),
      getManager: () => makeManager(liveSplitPane),
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1 } as ManagedPane,
      direction: 'vertical',
      source: 'context_menu'
    })

    await flushAsyncSplit()

    expect(staleSplitPane).not.toHaveBeenCalled()
    expect(liveSplitPane).toHaveBeenCalledWith(1, 'vertical', {
      cwd: '/resolved',
      position: 'after'
    })
    expect(mocks.recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(
      { id: 2 },
      { source: 'context_menu', direction: 'vertical' }
    )
  })

  it('forwards a leading position through the cached-cwd path', () => {
    const splitPane = vi.fn(() => ({ id: 2 }))

    splitTerminalPaneWithInheritedCwd({
      manager: makeManager(splitPane),
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map([[1, { cwd: '/cached', confirmed: true }]]),
      fallbackCwd: '/fallback',
      pane: { id: 1 } as ManagedPane,
      direction: 'vertical',
      position: 'before',
      source: 'context_menu'
    })

    expect(splitPane).toHaveBeenCalledWith(1, 'vertical', { cwd: '/cached', position: 'before' })
  })

  it('forwards a leading position through the async cwd path', async () => {
    const splitPane = vi.fn(() => ({ id: 2 }))
    mocks.resolveSplitCwd.mockResolvedValue('/resolved')

    splitTerminalPaneWithInheritedCwd({
      manager: makeManager(splitPane),
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1 } as ManagedPane,
      direction: 'horizontal',
      position: 'before',
      source: 'context_menu'
    })

    await flushAsyncSplit()

    expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', {
      cwd: '/resolved',
      position: 'before'
    })
  })

  it('hands the position to the remote runtime so SSH panes split the same way', () => {
    const splitPane = vi.fn()
    const transport = { getPtyId: () => 'remote-pty' } as unknown as PtyTransport
    mocks.splitWebRuntimeTerminal.mockReturnValue(true)

    splitTerminalPaneWithInheritedCwd({
      manager: makeManager(splitPane),
      paneTransports: new Map([[1, transport]]),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1 } as ManagedPane,
      direction: 'vertical',
      position: 'before',
      source: 'context_menu'
    })

    expect(mocks.splitWebRuntimeTerminal).toHaveBeenCalledWith(
      'remote-pty',
      'vertical',
      'context_menu',
      'before'
    )
    // Why: the host owns the remote split; a local one would mint a mirrored tab instead.
    expect(splitPane).not.toHaveBeenCalled()
  })

  it('does not split a stale manager when the live manager is gone', async () => {
    const staleSplitPane = vi.fn()
    mocks.resolveSplitCwd.mockResolvedValue('/resolved')

    splitTerminalPaneWithInheritedCwd({
      manager: makeManager(staleSplitPane),
      getManager: () => null,
      paneTransports: new Map<number, PtyTransport>(),
      paneCwdMap: new Map(),
      fallbackCwd: '/fallback',
      pane: { id: 1 } as ManagedPane,
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
