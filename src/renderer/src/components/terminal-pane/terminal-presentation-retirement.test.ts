// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
import { captureTerminalSurfaceIdentity } from '../../../../shared/terminal-tab-close'
import {
  removeTerminalPresentation,
  retireTerminalPresentation
} from './terminal-presentation-retirement'
import { capturedPanesByTabId, parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import { LEAF, SIBLING, mountedOwner } from './terminal-presentation-retirement.test-fixture'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

function prepare(split: boolean) {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [makeTerminalTab({ id: 'terminal', worktreeId: 'wt-1' })] },
    terminalLayoutsByTabId: {
      terminal: {
        root: split
          ? {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: SIBLING }
            }
          : { type: 'leaf', leafId: LEAF },
        activeLeafId: split ? SIBLING : LEAF,
        expandedLeafId: split ? SIBLING : null,
        chatLeafId: LEAF,
        ptyIdsByLeafId: { [LEAF]: 'pty-1', ...(split ? { [SIBLING]: 'pty-2' } : {}) }
      }
    }
  })
  useAppStore
    .getState()
    .createUnifiedTab('wt-1', 'terminal', { id: 'terminal', entityId: 'terminal' })
  const identity = captureTerminalSurfaceIdentity(useAppStore.getState(), 'wt-1', 'terminal', LEAF)
  if (!identity) {
    throw new Error('Expected source identity')
  }
  return identity
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  capturedPanesByTabId.clear()
  parkedWatchersByTabId.clear()
})

describe('direct permanent presentation owner', () => {
  it.each([true, false])(
    'disposes mounted resources and canonical membership (split=%s)',
    (split) => {
      const identity = prepare(split)
      const owner = mountedOwner(split)
      capturedPanesByTabId.set('terminal', {
        worktreeId: 'wt-1',
        panes: [{ paneId: 1, leafId: LEAF, ptyId: 'pty-1', drivesTabTitle: true }]
      })
      try {
        retireTerminalPresentation(identity)
        expect(owner.source.terminal.dispose).toHaveBeenCalledOnce()
        expect(owner.source.searchAddon.dispose).toHaveBeenCalledOnce()
        expect(owner.sourceTransport.detach).toHaveBeenCalledExactlyOnceWith({
          preserveExitObserver: false
        })
        expect(owner.sourceTransport.destroy).not.toHaveBeenCalled()
        expect(owner.transports.has(1)).toBe(false)
        expect(owner.bindings.has(1)).toBe(false)
        expect(capturedPanesByTabId.has('terminal')).toBe(false)
        expect(owner.binding.dispose).toHaveBeenCalledOnce()
        expect(owner.link.dispose).toHaveBeenCalledOnce()
        expect(owner.panes.has(1)).toBe(false)
        expect(owner.setPaneCount).toHaveBeenLastCalledWith(split ? 1 : 0)
        const state = useAppStore.getState()
        if (split) {
          expect(owner.other.terminal.dispose).not.toHaveBeenCalled()
          expect(state.terminalLayoutsByTabId.terminal).toMatchObject({
            root: { type: 'leaf', leafId: SIBLING },
            activeLeafId: SIBLING,
            expandedLeafId: SIBLING,
            ptyIdsByLeafId: { [SIBLING]: 'pty-2' }
          })
          expect(state.terminalLayoutsByTabId.terminal.chatLeafId).toBeUndefined()
        } else {
          expect(owner.manager.destroy).toHaveBeenCalledOnce()
          expect(owner.cancelResize).toHaveBeenCalledOnce()
          expect(owner.expandedElement.style.display).toBe('flex')
          expect(capturedPanesByTabId.has('terminal')).toBe(false)
          expect(owner.onLayoutChanged).not.toHaveBeenCalled()
          expect(hasRegisteredRuntimeTerminalTab('terminal', 'wt-1')).toBe(false)
          expect(state.tabsByWorktree['wt-1']).toEqual([])
          expect(state.terminalLayoutsByTabId.terminal).toBeUndefined()
        }
      } finally {
        owner.unregister()
      }
    }
  )

  it.each([true, false])(
    'disposes exact parked captures, including empty watcher entries (split=%s)',
    (split) => {
      const identity = prepare(split)
      const dispose = vi.fn()
      const siblingDispose = vi.fn()
      capturedPanesByTabId.set('terminal', {
        worktreeId: 'wt-1',
        panes: [
          { paneId: 1, leafId: LEAF, ptyId: 'pty-1', drivesTabTitle: true },
          ...(split ? [{ paneId: 2, leafId: SIBLING, ptyId: 'pty-2', drivesTabTitle: false }] : [])
        ]
      })
      parkedWatchersByTabId.set('terminal', {
        worktreeId: 'wt-1',
        tabPtyId: 'pty-1',
        paneIdByPtyId: new Map([['pty-1', 1], ...(split ? [['pty-2', 2] as const] : [])]),
        disposersByPtyId: new Map(
          split
            ? [
                ['pty-1', dispose],
                ['pty-2', siblingDispose]
              ]
            : []
        )
      })
      retireTerminalPresentation(identity)
      expect(siblingDispose).not.toHaveBeenCalled()
      if (split) {
        expect(dispose).toHaveBeenCalledOnce()
        expect(capturedPanesByTabId.get('terminal')?.panes.map((pane) => pane.leafId)).toEqual([
          SIBLING
        ])
        expect([...parkedWatchersByTabId.get('terminal')!.paneIdByPtyId.keys()]).toEqual(['pty-2'])
      } else {
        expect(capturedPanesByTabId.has('terminal')).toBe(false)
        expect(parkedWatchersByTabId.has('terminal')).toBe(false)
      }
    }
  )

  it('refuses a replacement or a newly pinned final tab before disposal', () => {
    const identity = prepare(false)
    const owner = mountedOwner(false)
    try {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          terminal: {
            ...useAppStore.getState().terminalLayoutsByTabId.terminal,
            ptyIdsByLeafId: { [LEAF]: 'replacement' }
          }
        }
      })
      expect(() => retireTerminalPresentation(identity)).toThrow('terminal_pane_owner_changed')
      expect(owner.source.terminal.dispose).not.toHaveBeenCalled()
      useAppStore.setState({
        terminalLayoutsByTabId: {
          terminal: {
            ...useAppStore.getState().terminalLayoutsByTabId.terminal,
            ptyIdsByLeafId: { [LEAF]: 'pty-1' }
          }
        },
        tabsByWorktree: {
          'wt-1': [{ ...useAppStore.getState().tabsByWorktree['wt-1'][0], isPinned: true }]
        }
      })
      expect(() => retireTerminalPresentation(identity)).toThrow('terminal_tab_pinned')
      expect(owner.source.terminal.dispose).not.toHaveBeenCalled()
    } finally {
      owner.unregister()
    }
  })

  it('reports a real disposer failure and retains source membership', () => {
    const identity = prepare(false)
    const owner = mountedOwner(false)
    owner.source.paneDragCleanup = () => {
      throw new Error('disposal failed')
    }
    try {
      expect(() => retireTerminalPresentation(identity)).toThrow('disposal failed')
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
      expect(owner.sourceTransport.destroy).not.toHaveBeenCalled()
    } finally {
      owner.unregister()
    }
  })
  it('reports nested actual addon/terminal failures after closure and layout, while ordinary callers remain best effort', () => {
    const identity = prepare(false)
    const owner = mountedOwner(false)
    const image = owner.source.imageAddon
    const webgl = owner.source.webglAddon
    if (!image || !webgl) {
      throw new Error('Expected actual addon owners')
    }
    vi.spyOn(image, 'dispose').mockImplementation(() => {
      throw undefined
    })
    vi.spyOn(webgl, 'dispose').mockImplementation(() => {
      throw false
    })
    vi.spyOn(owner.source.terminal, 'dispose').mockImplementation(() => {
      throw new Error('terminal failed')
    })
    try {
      let failure: unknown
      try {
        retireTerminalPresentation(identity)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) {
        throw new Error('Expected failure')
      }
      expect(failure.errors).toEqual([undefined, false, new Error('terminal failed')])
      expect(owner.source.searchAddon.dispose).toHaveBeenCalledOnce()
      expect(owner.binding.dispose).toHaveBeenCalledOnce()
      expect(owner.sourceTransport.detach).toHaveBeenCalledOnce()
      expect(owner.manager.destroy).toHaveBeenCalledOnce()
      expect(useAppStore.getState().terminalLayoutsByTabId.terminal).toBeUndefined()
      expect(hasRegisteredRuntimeTerminalTab('terminal', 'wt-1')).toBe(false)
    } finally {
      owner.unregister()
    }

    prepare(false)
    const ordinary = mountedOwner(false)
    vi.spyOn(ordinary.source.searchAddon, 'dispose').mockImplementation(() => {
      throw new Error('advisory')
    })
    try {
      expect(() => ordinary.manager.retirePanePreservingPty(1, true)).not.toThrow()
      expect(ordinary.source.terminal.dispose).toHaveBeenCalledOnce()
    } finally {
      ordinary.unregister()
    }
  })

  it.each(['DOM', 'onPaneClosed'] as const)(
    'retains caught and genuine %s and final-owner failures without claiming structural completion',
    (stage) => {
      const identity = prepare(false)
      const owner = mountedOwner(false)
      const caught = new Error('addon failed')
      const structural = new Error(stage)
      const final = new Error('onEmpty failed')
      vi.spyOn(owner.source.searchAddon, 'dispose').mockImplementation(() => {
        throw caught
      })
      if (stage === 'DOM') {
        document.body.append(owner.source.container)
        vi.spyOn(owner.source.container, 'remove').mockImplementation(() => {
          throw structural
        })
      } else {
        owner.link.dispose.mockImplementation(() => {
          throw structural
        })
      }
      owner.empty.mockImplementation(() => {
        throw final
      })
      try {
        let failure: unknown
        try {
          retireTerminalPresentation(identity)
        } catch (error) {
          failure = error
        }
        if (!(failure instanceof AggregateError)) {
          throw new Error('Expected aggregate')
        }
        expect(failure.errors[0]).toBe(caught)
        expect(failure.errors[1]).toBeInstanceOf(AggregateError)
        expect(failure.errors[1].errors).toEqual([structural, final])
        expect(owner.empty).toHaveBeenCalledOnce()
        expect(owner.panes.size).toBe(0)
        expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
        expect(hasRegisteredRuntimeTerminalTab('terminal', 'wt-1')).toBe(false)
      } finally {
        owner.unregister()
        document.body.replaceChildren()
      }
    }
  )

  it('preserves an ordinary previously unswallowed owner throw', () => {
    prepare(false)
    const owner = mountedOwner(false)
    owner.source.paneDragCleanup = () => {
      throw new Error('ordinary owner failed')
    }
    try {
      expect(() => owner.manager.retirePanePreservingPty(1, true)).toThrow('ordinary owner failed')
      expect(owner.panes.size).toBe(1)
    } finally {
      owner.unregister()
    }
  })

  it('retains caught failures when layout throws, and rejects them even after an already-absent leaf', () => {
    const identity = prepare(true)
    const caught = new Error('caught disposal')
    const layoutFailure = new Error('layout failed')
    const originalSet = useAppStore.getState().setTabLayout
    useAppStore.setState({
      setTabLayout: () => {
        throw layoutFailure
      }
    })
    try {
      let failure: unknown
      try {
        removeTerminalPresentation(identity, (failures) => {
          failures.push(caught)
        })
      } catch (error) {
        failure = error
      }
      if (!(failure instanceof AggregateError)) {
        throw new Error('Expected aggregate')
      }
      expect(failure.errors).toEqual([caught, layoutFailure])
    } finally {
      useAppStore.setState({ setTabLayout: originalSet })
    }
    useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })
    expect(() =>
      removeTerminalPresentation(identity, (failures) => {
        failures.push(caught)
      })
    ).toThrow(AggregateError)
  })
})
