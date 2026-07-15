import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalPaneCloseRequest,
  applyTerminalScrollbackRowsToMountedPanes,
  clearQueuedInitialCwdAfterFirstPane,
  createRetryableTerminalTransportDestroyCleanup,
  createTerminalPaneSplitEventHandler,
  disposeTrackedTerminalPaneResource,
  disposeTerminalPaneResources,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume,
  mapRestoredPaneTitlesByPaneId,
  resolvePaneLinkCwd,
  resolvePaneSeedCwd,
  resolveQueuedInitialCwd,
  resetTerminalKeyboardProtocolAfterInterrupt,
  retireMountedTerminalPaneSurface,
  shouldDetachPaneTransportOnUnmount,
  splitPaneWithOneShotStartup,
  suppressIntentionalPaneCloseExit
} from './use-terminal-pane-lifecycle'
import {
  SPLIT_TERMINAL_PANE_EVENT,
  type SplitTerminalPaneAcknowledgement,
  type SplitTerminalPaneDetail
} from '@/constants/terminal'

describe('applyTerminalPaneCloseRequest', () => {
  it('detaches a rolled-back split surface without closing its PTY', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getNumericIdForLeaf: vi.fn(() => 2),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true
        },
        manager,
        closeTab,
        closeTabPreservingPty
      })
    ).toBe('pane')
    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(2)
    expect(manager.closePane).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
    expect(closeTabPreservingPty).not.toHaveBeenCalled()
  })

  it('uses non-destructive tab close semantics for the last rolled-back pane', () => {
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          tabId: 'legacy-worker',
          paneRuntimeId: 1,
          preservePty: true
        },
        manager: {
          getPanes: vi.fn(() => [{ id: 1 }]),
          getNumericIdForLeaf: vi.fn(() => 1),
          closePane: vi.fn(),
          detachPaneForExternalMove: vi.fn(() => true),
          retirePanePreservingPty: vi.fn(() => true)
        },
        closeTab,
        closeTabPreservingPty
      })
    ).toBe('tab')
    expect(closeTabPreservingPty).toHaveBeenCalledOnce()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('ignores a delayed rollback after the pane PTY identity changed', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }]),
      getNumericIdForLeaf: vi.fn(() => 1),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }
    const closeTab = vi.fn()
    const closeTabPreservingPty = vi.fn()

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true,
          expectedPtyId: 'pty-legacy'
        },
        manager,
        closeTab,
        closeTabPreservingPty,
        getPtyIdForLeaf: () => 'pty-replacement'
      })
    ).toBe('ignored')
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(closeTabPreservingPty).not.toHaveBeenCalled()
  })

  it('retires a mounted rollback pane without detaching it as a movable surface', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1 }, { id: 2 }]),
      getNumericIdForLeaf: vi.fn(() => 2),
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(() => true),
      retirePanePreservingPty: vi.fn(() => true)
    }

    expect(
      applyTerminalPaneCloseRequest({
        detail: {
          tabId: 'legacy-worker',
          leafId: '11111111-1111-4111-8111-111111111111',
          preservePty: true,
          retireSurface: true,
          expectedPtyId: 'pty-legacy'
        },
        manager,
        closeTab: vi.fn(),
        closeTabPreservingPty: vi.fn(),
        getPtyIdForLeaf: () => 'pty-legacy'
      })
    ).toBe('pane')
    expect(manager.retirePanePreservingPty).toHaveBeenCalledWith(2)
    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('retires mounted authority and binding while preserving the process and sleeping fence', () => {
    const retireAgentPaneAuthority = vi.fn()
    const syncPanePtyLayoutBinding = vi.fn()
    const clearTabPtyId = vi.fn()
    const transport = { detach: vi.fn(), destroy: vi.fn() }

    retireMountedTerminalPaneSurface({
      paneKey: 'legacy-worker:11111111-1111-4111-8111-111111111111',
      paneId: 2,
      tabId: 'legacy-worker',
      ptyId: 'pty-legacy',
      retireAgentPaneAuthority,
      syncPanePtyLayoutBinding,
      clearTabPtyId,
      transport
    })

    expect(retireAgentPaneAuthority).toHaveBeenCalledWith(
      'legacy-worker:11111111-1111-4111-8111-111111111111',
      { preserveSleepingAgentSession: true }
    )
    expect(syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, null)
    expect(clearTabPtyId).toHaveBeenCalledWith('legacy-worker', 'pty-legacy')
    expect(transport.detach).toHaveBeenCalledOnce()
    expect(transport.destroy).not.toHaveBeenCalled()
  })
})

describe('resetTerminalKeyboardProtocolAfterInterrupt', () => {
  it('does not write to an xterm whose pipeline is certified dead', async () => {
    const { _resetWritePipelineHealthForTests, notifyUndeliverableWrite } =
      await import('@/lib/pane-manager/terminal-write-pipeline-health')
    const terminal = { write: vi.fn() }
    try {
      notifyUndeliverableWrite(terminal, 'replay-wedged')

      resetTerminalKeyboardProtocolAfterInterrupt(terminal as never)

      expect(terminal.write).not.toHaveBeenCalled()
    } finally {
      _resetWritePipelineHealthForTests(terminal)
    }
  })
})

describe('splitPaneWithOneShotStartup', () => {
  it('only exposes startup to the intentional split and clears it afterwards', () => {
    const deps: { startup?: { command: string; env?: Record<string, string> } | null } = {
      startup: null
    }
    const seenStartupValues: (typeof deps.startup)[] = []

    const createdPane = splitPaneWithOneShotStartup(
      deps,
      { command: 'orca setup', env: { ORCA_ROLE: 'setup' } },
      () => {
        seenStartupValues.push(deps.startup ?? null)
        return { id: 2 }
      }
    )

    expect(createdPane).toEqual({ id: 2 })
    expect(seenStartupValues).toEqual([{ command: 'orca setup', env: { ORCA_ROLE: 'setup' } }])
    expect(deps.startup).toBeNull()
  })

  it('isolates startup payloads across sequential calls (setup then issue)', () => {
    const deps: { startup?: { command: string; env?: Record<string, string> } | null } = {
      startup: null
    }
    const seenStartupValues: (typeof deps.startup)[] = []

    splitPaneWithOneShotStartup(
      deps,
      { command: 'orca setup', env: { ORCA_ROLE: 'setup' } },
      () => {
        seenStartupValues.push(deps.startup ?? null)
        return { id: 2 }
      }
    )

    expect(deps.startup).toBeNull()

    splitPaneWithOneShotStartup(deps, { command: 'orca issue' }, () => {
      seenStartupValues.push(deps.startup ?? null)
      return { id: 3 }
    })

    expect(seenStartupValues).toEqual([
      { command: 'orca setup', env: { ORCA_ROLE: 'setup' } },
      { command: 'orca issue' }
    ])
    expect(deps.startup).toBeNull()

    const userSplitObservedStartup = ((splitPane: () => { id: number }) => {
      splitPane()
      return deps.startup ?? null
    })(() => ({ id: 4 }))

    expect(userSplitObservedStartup).toBeNull()
    expect(deps.startup).toBeNull()
  })

  it('clears startup even when splitPane throws', () => {
    const deps: { startup?: { command: string } | null } = { startup: null }
    const splitPane = vi.fn(() => {
      throw new Error('split failed')
    })

    expect(() => splitPaneWithOneShotStartup(deps, { command: 'orca setup' }, splitPane)).toThrow(
      'split failed'
    )

    expect(splitPane).toHaveBeenCalledTimes(1)
    expect(deps.startup).toBeNull()
  })
})

describe('disposeTerminalPaneResources', () => {
  it('runs every cleanup step and preserves multiple cleanup failures', () => {
    const cleanupOrder: string[] = []

    expect(() =>
      disposeTerminalPaneResources([
        () => {
          cleanupOrder.push('parser')
          throw new Error('parser cleanup failed')
        },
        () => cleanupOrder.push('listener'),
        () => {
          cleanupOrder.push('transport')
          throw new Error('transport cleanup failed')
        },
        () => cleanupOrder.push('timer')
      ])
    ).toThrow(AggregateError)

    expect(cleanupOrder).toEqual(['parser', 'listener', 'transport', 'timer'])
  })

  it('retries only failed cleanup steps and releases their tracked handle after success', () => {
    const cleanupOrder: string[] = []
    const parserCleanup = vi
      .fn()
      .mockImplementationOnce(() => {
        cleanupOrder.push('parser-failed')
        throw new Error('parser cleanup failed')
      })
      .mockImplementationOnce(() => cleanupOrder.push('parser-retried'))
    const listenerCleanup = vi.fn(() => cleanupOrder.push('listener'))
    const cleanups = [parserCleanup, listenerCleanup]

    expect(() => disposeTerminalPaneResources(cleanups)).toThrow('parser cleanup failed')
    expect(cleanups).toHaveLength(1)
    expect(() => disposeTerminalPaneResources(cleanups)).not.toThrow()
    expect(cleanups).toHaveLength(0)
    expect(cleanupOrder).toEqual(['parser-failed', 'listener', 'parser-retried'])

    const tracked = new Map([[7, { dispose: parserCleanup }]])
    parserCleanup.mockImplementationOnce(() => {
      throw new Error('tracked cleanup failed')
    })
    expect(() => disposeTrackedTerminalPaneResource(tracked, 7)).toThrow('tracked cleanup failed')
    expect(tracked.has(7)).toBe(true)
    expect(() => disposeTrackedTerminalPaneResource(tracked, 7)).not.toThrow()
    expect(tracked.has(7)).toBe(false)
  })

  it('retains async transport ownership across rejection until a later destroy succeeds', async () => {
    let rejectFirstDestroy!: (error: Error) => void
    let resolveSecondDestroy!: () => void
    const firstDestroy = new Promise<void>((_resolve, reject) => {
      rejectFirstDestroy = reject
    })
    const secondDestroy = new Promise<void>((resolve) => {
      resolveSecondDestroy = resolve
    })
    const destroy = vi.fn().mockReturnValueOnce(firstDestroy).mockReturnValueOnce(secondDestroy)
    let owned = true
    const settled: ('fulfilled' | 'rejected')[] = []
    const cleanup = createRetryableTerminalTransportDestroyCleanup({
      destroy,
      releaseOwnership: () => {
        owned = false
      },
      onAsyncSettled: (status) => settled.push(status)
    })

    expect(() => cleanup()).toThrow('PTY destroy is still pending')
    expect(owned).toBe(true)
    rejectFirstDestroy(new Error('transient async destroy failure'))
    await firstDestroy.catch(() => undefined)
    await Promise.resolve()
    expect(settled).toEqual(['rejected'])
    expect(owned).toBe(true)

    expect(() => cleanup()).toThrow('PTY destroy is still pending')
    expect(destroy).toHaveBeenCalledTimes(2)
    expect(owned).toBe(true)
    resolveSecondDestroy()
    await secondDestroy
    await Promise.resolve()
    expect(settled).toEqual(['rejected', 'fulfilled'])
    expect(owned).toBe(true)

    expect(() => cleanup()).not.toThrow()
    expect(owned).toBe(false)
    expect(() => cleanup()).not.toThrow()
    expect(destroy).toHaveBeenCalledTimes(2)
  })

  it('retries only ownership release after synchronous transport destruction succeeds', () => {
    const destroy = vi.fn()
    const releaseOwnership = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('ownership release failed')
      })
      .mockImplementationOnce(() => undefined)
    const cleanup = createRetryableTerminalTransportDestroyCleanup({
      destroy,
      releaseOwnership,
      onAsyncSettled: vi.fn()
    })

    expect(() => cleanup()).toThrow('ownership release failed')
    expect(() => cleanup()).not.toThrow()
    expect(destroy).toHaveBeenCalledOnce()
    expect(releaseOwnership).toHaveBeenCalledTimes(2)
  })
})

describe('transactional terminal split event listener', () => {
  const tabId = 'tab-grid'
  const sourceLeafId = '11111111-1111-4111-8111-111111111111'
  const newLeafId = '22222222-2222-4222-8222-222222222222'

  function createManager(overrides: Record<string, unknown> = {}) {
    return {
      getNumericIdForLeaf: vi.fn((leafId: string) => (leafId === sourceLeafId ? 1 : null)),
      getPanes: vi.fn(() => [{ id: 1 }]),
      getActivePane: vi.fn(() => ({ id: 1 })),
      splitPane: vi.fn(() => ({ id: 2, leafId: newLeafId })),
      splitPaneAroundLeafIds: vi.fn(() => ({ id: 2, leafId: newLeafId })),
      arrangeOrchestrationGrid: vi.fn(),
      setActivePane: vi.fn(),
      closePane: vi.fn(),
      ...overrides
    }
  }

  function dispatchSplit(args: {
    manager: ReturnType<typeof createManager> | null
    detail?: Partial<SplitTerminalPaneDetail>
    startupDeps?: { startup?: { command: string } | null }
    recordSplit?: (createdPane: unknown, splitArgs: unknown) => unknown
    publishCommittedSplit?: () => void
    getExpandedPaneId?: () => number | null
    setExpandedPane?: (paneId: number | null) => void
    syncExpandedLayout?: () => void
  }): ReturnType<typeof vi.fn> {
    const acknowledge = vi.fn<(result: SplitTerminalPaneAcknowledgement) => void>()
    const target = new EventTarget()
    target.addEventListener(
      SPLIT_TERMINAL_PANE_EVENT,
      createTerminalPaneSplitEventHandler(
        Object.assign(
          {
            tabId,
            getManager: () => args.manager as never,
            startupDeps: args.startupDeps ?? { startup: null },
            recordSplit: (createdPane, splitArgs) => {
              args.recordSplit?.(createdPane, splitArgs)
              return true
            },
            consumeMirrorTelemetry: vi.fn(() => false),
            publishCommittedSplit: args.publishCommittedSplit
          },
          {
            getExpandedPaneId: args.getExpandedPaneId,
            setExpandedPane: args.setExpandedPane,
            syncExpandedLayout: args.syncExpandedLayout
          }
        )
      )
    )
    target.dispatchEvent(
      new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
        detail: {
          tabId,
          paneRuntimeId: -1,
          direction: 'vertical',
          sourceLeafId,
          sourceLeafIds: [sourceLeafId],
          newLeafId,
          orchestrationGrid: true,
          activate: true,
          acknowledge,
          ...args.detail
        }
      })
    )
    return acknowledge
  }

  it('acknowledges one PTY-backed pane and exposes idempotent rollback before telemetry commit', () => {
    const manager = createManager()
    const recordSplit = vi.fn()
    const publishCommittedSplit = vi.fn()

    const acknowledge = dispatchSplit({
      manager,
      detail: { ptyId: 'pty-worker' },
      recordSplit,
      publishCommittedSplit
    })

    expect(acknowledge).toHaveBeenCalledOnce()
    const result = acknowledge.mock.calls[0]![0]
    expect(result.status).toBe('success')
    expect(manager.splitPaneAroundLeafIds).toHaveBeenCalledWith(
      [sourceLeafId],
      1,
      'vertical',
      expect.objectContaining({
        leafId: newLeafId,
        ptyId: 'pty-worker',
        allowOrchestrationGridMutation: true,
        notifyLayoutChanged: false
      })
    )
    expect(recordSplit).not.toHaveBeenCalled()
    expect(publishCommittedSplit).not.toHaveBeenCalled()
    expect(manager.setActivePane).not.toHaveBeenCalled()
    if (result.status !== 'success') {
      throw new Error('Expected a successful split acknowledgement')
    }
    result.afterCommit?.()
    expect(recordSplit).toHaveBeenCalledOnce()
    expect(publishCommittedSplit).toHaveBeenCalledOnce()
    expect(manager.setActivePane).toHaveBeenCalledOnce()
    expect(manager.setActivePane).toHaveBeenCalledWith(2)
    manager.setActivePane.mockClear()
    result.rollback()
    result.rollback()
    expect(manager.closePane).toHaveBeenCalledOnce()
    expect(manager.closePane).toHaveBeenCalledWith(2, { notifyLayoutChanged: false })
    expect(manager.setActivePane).toHaveBeenCalledOnce()
    expect(manager.setActivePane).toHaveBeenCalledWith(1, {
      focus: false,
      notifyActiveChange: false
    })
  })

  it('collapses an expanded eight-pane maintained grid before appending the ninth pane', () => {
    const elements = Array.from({ length: 9 }, () => ({ style: { display: '' } }))
    const panes = elements.slice(0, 8).map((container, index) => ({ id: index + 1, container }))
    let expandedPaneId: number | null = 1
    for (const pane of panes.slice(1)) {
      pane.container.style.display = 'none'
    }
    const operations: string[] = []
    const manager = createManager({
      getPanes: vi.fn(() => panes),
      splitPaneAroundLeafIds: vi.fn(() => {
        const created = { id: 9, leafId: newLeafId, container: elements[8]! }
        panes.push(created)
        return created
      }),
      arrangeOrchestrationGrid: vi.fn(() => operations.push('arrange')),
      closePane: vi.fn((paneId: number) => {
        const index = panes.findIndex((pane) => pane.id === paneId)
        if (index >= 0) {
          panes.splice(index, 1)
        }
      })
    })
    const setExpandedPane = vi.fn((paneId: number | null) => {
      expandedPaneId = paneId
      operations.push(`expand:${paneId ?? 'none'}`)
    })
    const syncExpandedLayout = vi.fn(() => {
      operations.push('sync')
      for (const pane of panes) {
        pane.container.style.display =
          expandedPaneId === null || pane.id === expandedPaneId ? '' : 'none'
      }
    })

    const acknowledge = dispatchSplit({
      manager,
      detail: { ptyId: 'pty-worker-9' },
      getExpandedPaneId: () => expandedPaneId,
      setExpandedPane,
      syncExpandedLayout
    })

    expect(acknowledge.mock.calls[0]![0].status).toBe('success')
    expect(operations).toEqual(['expand:none', 'sync', 'arrange'])
    expect(panes).toHaveLength(9)
    expect(panes.every((pane) => pane.container.style.display !== 'none')).toBe(true)
    expect(expandedPaneId).toBeNull()

    const result = acknowledge.mock.calls[0]![0]
    if (result.status !== 'success') {
      throw new Error('Expected a successful split acknowledgement')
    }
    result.rollback()
    result.rollback()

    expect(panes).toHaveLength(8)
    expect(expandedPaneId).toBe(1)
    expect(panes[0]!.container.style.display).not.toBe('none')
    expect(panes.slice(1).every((pane) => pane.container.style.display === 'none')).toBe(true)
  })

  it('keeps acknowledged rollback retryable when the first close cleanup throws', () => {
    const manager = createManager({
      closePane: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('transient pane cleanup failure')
        })
        .mockImplementationOnce(() => undefined)
    })
    const acknowledge = dispatchSplit({ manager, detail: { ptyId: 'pty-worker' } })
    const result = acknowledge.mock.calls[0]![0]
    if (result.status !== 'success') {
      throw new Error('Expected a successful split acknowledgement')
    }
    manager.setActivePane.mockClear()

    expect(() => result.rollback()).toThrow('transient pane cleanup failure')
    expect(() => result.rollback()).not.toThrow()
    result.rollback()

    expect(manager.closePane).toHaveBeenCalledTimes(2)
    expect(manager.setActivePane).toHaveBeenCalledTimes(2)
  })

  it('scopes a renderer-backed startup to pane creation and clears it after acknowledgement', () => {
    const startupDeps: { startup?: { command: string } | null } = { startup: null }
    const observedStartup: unknown[] = []
    const manager = createManager({
      splitPaneAroundLeafIds: vi.fn(() => {
        observedStartup.push(startupDeps.startup)
        return { id: 2, leafId: newLeafId }
      })
    })

    const acknowledge = dispatchSplit({
      manager,
      detail: { startup: { command: 'codex --worker' } },
      startupDeps
    })

    expect(acknowledge).toHaveBeenCalledOnce()
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({ status: 'success' })
    expect(observedStartup).toEqual([{ command: 'codex --worker' }])
    expect(startupDeps.startup).toBeNull()
  })

  it.each([
    {
      name: 'manager absence',
      manager: null,
      expected: 'manager'
    },
    {
      name: 'duplicate leaf',
      manager: createManager({
        getNumericIdForLeaf: vi.fn((leafId: string) =>
          leafId === sourceLeafId ? 1 : leafId === newLeafId ? 2 : null
        )
      }),
      expected: 'already exists'
    },
    {
      name: 'invalid source',
      manager: createManager({ getNumericIdForLeaf: vi.fn(() => null) }),
      expected: 'source'
    },
    {
      name: 'null split',
      manager: createManager({ splitPaneAroundLeafIds: vi.fn(() => null) }),
      expected: 'did not create'
    }
  ])('acknowledges $name as one action failure', ({ manager, expected }) => {
    const acknowledge = dispatchSplit({ manager })

    expect(acknowledge).toHaveBeenCalledOnce()
    const result = acknowledge.mock.calls[0]![0]
    expect(result.status).toBe('failure')
    if (result.status === 'failure') {
      expect(result.error).toEqual(
        expect.objectContaining({ message: expect.stringContaining(expected) })
      )
    }
  })

  it('acknowledges an exception raised during listener preflight', () => {
    const manager = createManager({
      getNumericIdForLeaf: vi.fn(() => {
        throw new Error('listener preflight failed')
      })
    })

    const acknowledge = dispatchSplit({ manager })

    expect(acknowledge).toHaveBeenCalledOnce()
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({
      status: 'failure',
      error: expect.objectContaining({ message: 'listener preflight failed' })
    })
  })

  it('rolls back a created pane when the listener throws before acknowledgement', () => {
    const manager = createManager({
      arrangeOrchestrationGrid: vi.fn(() => {
        throw new Error('arrange failed')
      })
    })

    const acknowledge = dispatchSplit({ manager })

    expect(acknowledge).toHaveBeenCalledOnce()
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({
      status: 'failure',
      error: expect.objectContaining({ message: 'arrange failed' })
    })
    expect(manager.closePane).toHaveBeenCalledOnce()
  })

  it('keeps the listener operation error primary when rollback cleanup also fails', () => {
    const manager = createManager({
      arrangeOrchestrationGrid: vi.fn(() => {
        throw new Error('arrange failed')
      }),
      closePane: vi.fn(() => {
        throw new Error('pane cleanup failed')
      })
    })

    const acknowledge = dispatchSplit({ manager })

    expect(acknowledge).toHaveBeenCalledOnce()
    const result = acknowledge.mock.calls[0]![0]
    expect(result.status).toBe('failure')
    if (result.status === 'failure') {
      expect(result.error).toBeInstanceOf(AggregateError)
      expect((result.error as Error).message).toContain('arrange failed')
      expect((result.error as Error).message).toContain('pane cleanup failed')
      expect((result.error as AggregateError).errors[0]).toEqual(
        expect.objectContaining({ message: 'arrange failed' })
      )
    }
  })

  it('does not acknowledge a listener registered for another tab', () => {
    const acknowledge = dispatchSplit({
      manager: createManager(),
      detail: { tabId: 'tab-other' }
    })

    expect(acknowledge).not.toHaveBeenCalled()
  })
})

describe('applyTerminalScrollbackRowsToMountedPanes', () => {
  it('updates mounted pane xterm scrollback options only when needed', () => {
    const firstOptions = { scrollback: 1_000 }
    const secondOptions = { scrollback: 5_000 }
    const firstTerminal = { options: firstOptions }
    let secondWrites = 0
    const secondTerminal = {
      options: {
        get scrollback() {
          return secondOptions.scrollback
        },
        set scrollback(value: number | undefined) {
          secondWrites += 1
          secondOptions.scrollback = value ?? 0
        }
      }
    }
    const manager = {
      getPanes: vi.fn(() => [{ terminal: firstTerminal }, { terminal: secondTerminal }])
    }

    applyTerminalScrollbackRowsToMountedPanes(manager, 5_000)

    expect(firstTerminal.options.scrollback).toBe(5_000)
    expect(secondOptions.scrollback).toBe(5_000)
    expect(secondWrites).toBe(0)
    expect(manager.getPanes).toHaveBeenCalledTimes(1)
  })
})

describe('shouldDetachPaneTransportOnUnmount', () => {
  it('detaches when the tab still owns the transport PTY', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: true,
        tabId: 'tab-1',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: []
      })
    ).toBe(true)
  })

  it('detaches when a mirrored replacement tab owns the same PTY', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'local-tab',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: [
          {
            id: 'web-terminal-host-tab',
            ptyId: 'remote:env@@term-1',
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      })
    ).toBe(true)
  })

  it('detaches when closeTab already owns provider shutdown for the removed tab', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'tab-1',
        ptyId: 'remote:env@@term-1',
        worktreeTabs: []
      })
    ).toBe(true)
  })

  it('destroys an ID-less transport so a pending spawn cannot outlive unmount', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'tab-1',
        ptyId: null,
        worktreeTabs: []
      })
    ).toBe(false)
  })

  it('detaches a removed automation pane after closeTab takes teardown authority', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'automation-tab',
        ptyId: 'automation-pty',
        worktreeTabs: [
          {
            id: 'unrelated-tab',
            ptyId: 'unrelated-pty',
            worktreeId: 'wt-1',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      })
    ).toBe(true)
  })
})

describe('mapRestoredPaneTitlesByPaneId', () => {
  it('restores persisted pane titles onto newly-created pane ids', () => {
    const restoredPaneByLeafId = new Map([
      ['11111111-1111-4111-8111-111111111111', 7],
      ['22222222-2222-4222-8222-222222222222', 3]
    ])

    expect(
      mapRestoredPaneTitlesByPaneId(
        {
          '11111111-1111-4111-8111-111111111111': 'build logs',
          '22222222-2222-4222-8222-222222222222': 'test runner'
        },
        restoredPaneByLeafId
      )
    ).toEqual({
      7: 'build logs',
      3: 'test runner'
    })
  })

  it('ignores stale leaf ids and empty persisted titles', () => {
    expect(
      mapRestoredPaneTitlesByPaneId(
        {
          '11111111-1111-4111-8111-111111111111': 'build logs',
          '22222222-2222-4222-8222-222222222222': '',
          '33333333-3333-4333-8333-333333333333': 'closed pane'
        },
        new Map([['11111111-1111-4111-8111-111111111111', 2]])
      )
    ).toEqual({ 2: 'build logs' })
  })
})

describe('resolveQueuedInitialCwd', () => {
  it('consumes the queued initial cwd once when the ref is unset', () => {
    const consumeTabInitialCwd = vi.fn(() => '/repo/packages/web')

    expect(resolveQueuedInitialCwd(undefined, consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: '/repo/packages/web',
      startupCwd: '/repo/packages/web'
    })
    expect(consumeTabInitialCwd).toHaveBeenCalledTimes(1)
  })

  it('reuses the existing queued state without re-reading the store', () => {
    const consumeTabInitialCwd = vi.fn(() => '/repo/packages/web')

    expect(resolveQueuedInitialCwd(null, consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: null,
      startupCwd: '/repo'
    })
    expect(resolveQueuedInitialCwd('/repo/packages/web', consumeTabInitialCwd, '/repo')).toEqual({
      queuedInitialCwd: '/repo/packages/web',
      startupCwd: '/repo/packages/web'
    })
    expect(consumeTabInitialCwd).not.toHaveBeenCalled()
  })
})

describe('clearQueuedInitialCwdAfterFirstPane', () => {
  it('clears the one-shot cwd and restores the default cwd after the first pane', () => {
    expect(
      clearQueuedInitialCwdAfterFirstPane('/repo/packages/web', '/repo', '/repo/packages/web')
    ).toEqual({
      queuedInitialCwd: null,
      ptyCwd: '/repo'
    })
  })

  it('leaves the cwd unchanged when no one-shot override is queued', () => {
    expect(clearQueuedInitialCwdAfterFirstPane(null, '/repo', '/repo')).toEqual({
      queuedInitialCwd: null,
      ptyCwd: '/repo'
    })
  })
})

describe('resolvePaneLinkCwd', () => {
  it('prefers the pane-specific cwd when one has been seeded or confirmed', () => {
    expect(
      resolvePaneLinkCwd(
        new Map([[2, { cwd: '/repo/packages/web', confirmed: false }]]),
        2,
        '/repo'
      )
    ).toBe('/repo/packages/web')
  })

  it('falls back to the lifecycle startup cwd when the pane has no cached cwd yet', () => {
    expect(resolvePaneLinkCwd(new Map(), 2, '/repo')).toBe('/repo')
  })
})

describe('resolvePaneSeedCwd', () => {
  it('prefers the inherited split cwd before OSC 7 confirms the pane cwd', () => {
    expect(resolvePaneSeedCwd('/repo/packages/web', '/repo')).toBe('/repo/packages/web')
  })

  it('falls back to the lifecycle cwd when the pane has no split override', () => {
    expect(resolvePaneSeedCwd(undefined, '/repo')).toBe('/repo')
  })
})

describe('suppressIntentionalPaneCloseExit', () => {
  it('suppresses the pane PTY exit before intentional close teardown destroys the transport', () => {
    const suppressPtyExit = vi.fn()
    const transport = {
      getPtyId: vi.fn(() => 'pty-pane-2')
    }

    expect(suppressIntentionalPaneCloseExit(transport, suppressPtyExit)).toBe('pty-pane-2')
    expect(suppressPtyExit).toHaveBeenCalledWith('pty-pane-2')
  })

  it('does not suppress natural PTY exits that already cleared the transport id', () => {
    const suppressPtyExit = vi.fn()
    const transport = {
      getPtyId: vi.fn(() => null)
    }

    expect(suppressIntentionalPaneCloseExit(transport, suppressPtyExit)).toBeNull()
    expect(suppressPtyExit).not.toHaveBeenCalled()
  })
})

describe('terminal pane visibility resume tracking', () => {
  it('ignores previous visibility from a different terminal identity', () => {
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-old', cwd: '/repo', isVisible: false },
        tabId: 'tab-new',
        cwd: '/repo'
      })
    ).toBeNull()
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-1', cwd: '/repo-old', isVisible: false },
        tabId: 'tab-1',
        cwd: '/repo-new'
      })
    ).toBeNull()
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-1', cwd: '/repo', isVisible: false },
        tabId: 'tab-1',
        cwd: '/repo'
      })
    ).toBe(false)
  })

  it('identifies only hidden-to-visible changes as visibility resumes', () => {
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: null, isVisible: true })).toBe(false)
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: true, isVisible: true })).toBe(false)
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: true, isVisible: false })).toBe(
      false
    )
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: false, isVisible: true })).toBe(true)
  })
})
