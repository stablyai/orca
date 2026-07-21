/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DetachedTerminalSnapshot } from '../../../../shared/detached-terminal-window'

const shellMocks = vi.hoisted(() => ({
  terminalPaneProps: [] as Record<string, unknown>[],
  state: {} as Record<string, unknown>,
  getSnapshot: vi.fn(),
  closeWindow: vi.fn(),
  rendererPtyReady: vi.fn(),
  openWindow: vi.fn()
}))

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: (props: Record<string, unknown>) => {
    shellMocks.terminalPaneProps.push(props)
    return <div data-testid="detached-terminal-pane" />
  }
}))

vi.mock('@/store/slices/detached-terminal-hydration', () => ({
  hydrateDetachedTerminalSnapshot: (snapshot: DetachedTerminalSnapshot) => {
    shellMocks.state = {
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      ptyIdsByTabId: { [snapshot.terminalTab.id]: snapshot.ptyIds },
      terminalLayoutsByTabId: { [snapshot.terminalTab.id]: snapshot.terminalLayout },
      repos: snapshot.repos,
      worktreesByRepo: snapshot.worktreesByRepo
    }
  }
}))

function snapshot(overrides: Partial<DetachedTerminalSnapshot> = {}): DetachedTerminalSnapshot {
  const base: DetachedTerminalSnapshot = {
    worktree: { id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt' } as never,
    terminalTab: {
      id: 'tab-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    unifiedTab: {
      id: 'unified-1',
      entityId: 'tab-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'terminal',
      label: 'Terminal',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    group: { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'unified-1', tabOrder: ['unified-1'] },
    groupLayout: { type: 'leaf', groupId: 'group-1' },
    terminalLayout: {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-1': 'pty-1' }
    },
    activeGroupId: 'group-1',
    activeTabId: 'unified-1',
    repos: [{ id: 'repo-1', path: '/tmp/repo', connectionId: 'ssh-1' } as never],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/tmp/wt' } as never] },
    bufferSnapshotsByLeafId: {},
    settings: {} as never,
    keybindings: null,
    ptyIds: ['pty-1']
  }
  return { ...base, ...overrides }
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

async function renderShell(
  url = '/?mode=detached-terminal&worktreeId=wt-1&tabId=tab-1'
): Promise<HTMLDivElement> {
  window.history.replaceState(null, '', url)
  const { default: DetachedTerminalShell } = await import('./DetachedTerminalShell')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<DetachedTerminalShell />)
  })
  mounted.push({ container, root })
  return container
}

beforeEach(() => {
  vi.resetModules()
  shellMocks.terminalPaneProps = []
  shellMocks.state = {}
  shellMocks.getSnapshot.mockReset()
  shellMocks.closeWindow.mockReset().mockResolvedValue({ ok: true })
  shellMocks.rendererPtyReady.mockReset().mockResolvedValue({ ok: true })
  shellMocks.openWindow.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      detachedTerminal: {
        getSnapshot: shellMocks.getSnapshot,
        closeWindow: shellMocks.closeWindow,
        rendererPtyReady: shellMocks.rendererPtyReady,
        openWindow: shellMocks.openWindow
      }
    }
  })
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

describe('DetachedTerminalShell', () => {
  it('hydrates a single-pane snapshot before mounting TerminalPane', async () => {
    shellMocks.getSnapshot.mockResolvedValue(snapshot())
    const container = await renderShell()
    await act(async () => {})

    expect(container.querySelector('[data-testid="detached-terminal-pane"]')).not.toBeNull()
    expect(shellMocks.state.workspaceSessionReady).toBe(true)
    expect(shellMocks.state.ptyIdsByTabId).toEqual({ 'tab-1': ['pty-1'] })
    expect(shellMocks.terminalPaneProps[0]).toMatchObject({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      cwd: '/tmp/wt',
      isActive: true,
      isVisible: true,
      isWorktreeActive: true
    })
    expect(typeof shellMocks.terminalPaneProps[0]?.onPtyExit).toBe('function')
    expect(typeof shellMocks.terminalPaneProps[0]?.onCloseTab).toBe('function')
  })

  it('renders a draggable title bar strip so the detached window can be moved', async () => {
    shellMocks.getSnapshot.mockResolvedValue(snapshot())
    const container = await renderShell()
    await act(async () => {})

    const dragStrip = container.querySelector<HTMLElement>('[data-detached-titlebar-drag]')
    expect(dragStrip).not.toBeNull()
    expect(dragStrip?.classList.contains('titlebar')).toBe(true)
    // Why: the terminal surface must live outside the drag strip so xterm keeps
    // pointer selection/focus; assert it is a sibling, not a descendant.
    expect(
      dragStrip?.contains(container.querySelector('[data-testid="detached-terminal-pane"]'))
    ).toBe(false)
  })

  it('hydrates a split-pane snapshot and preserves every PTY from snapshot.ptyIds', async () => {
    shellMocks.getSnapshot.mockResolvedValue(
      snapshot({
        ptyIds: ['pty-1', 'pty-2'],
        terminalLayout: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' }
        }
      })
    )
    await renderShell()
    await act(async () => {})

    expect(shellMocks.state.ptyIdsByTabId).toEqual({ 'tab-1': ['pty-1', 'pty-2'] })
  })

  it('hydrates a remote-owner snapshot with repos and worktreesByRepo for SSH ownership', async () => {
    shellMocks.getSnapshot.mockResolvedValue(snapshot())
    await renderShell()
    await act(async () => {})

    expect(shellMocks.state.repos).toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: 'ssh-1' })])
    )
    expect(shellMocks.state.worktreesByRepo).toHaveProperty('repo-1')
  })

  it('renders loading and unavailable states without mounting the main app shell', async () => {
    let rejectSnapshot!: (error: Error) => void
    shellMocks.getSnapshot.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSnapshot = reject
      })
    )
    const container = await renderShell()
    expect(container.querySelector('[aria-label="Loading detached terminal"]')).not.toBeNull()
    await act(async () => {
      rejectSnapshot(new Error('detached_terminal_tab_unavailable'))
    })

    expect(container.querySelector('[aria-label="Detached terminal unavailable"]')).not.toBeNull()
    expect(shellMocks.terminalPaneProps).toHaveLength(0)
  })

  it('reports renderer PTY readiness and closes only the detached window', async () => {
    shellMocks.getSnapshot.mockResolvedValue(snapshot())
    await renderShell()
    await act(async () => {})

    const props = shellMocks.terminalPaneProps[0]
    const onReady = props?.onPtyDataSubscriptionReady as ((ptyId: string) => void) | undefined
    const onClose = props?.onCloseTab as (() => void) | undefined
    onReady?.('pty-1')
    onClose?.()

    expect(shellMocks.rendererPtyReady).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      ptyId: 'pty-1'
    })
    expect(shellMocks.closeWindow).toHaveBeenCalledWith({ worktreeId: 'wt-1', tabId: 'tab-1' })
  })
})
