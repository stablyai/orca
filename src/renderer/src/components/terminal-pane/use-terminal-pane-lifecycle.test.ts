import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalPaneCloseRequest,
  applyTerminalScrollbackRowsToMountedPanes,
  clearQueuedInitialCwdAfterFirstPane,
  createQueuedStartupConsumer,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume,
  mapRestoredPaneTitlesByPaneId,
  paneOwnsQueuedStartup,
  resolvePaneLinkCwd,
  resolvePaneSeedCwd,
  resolveQueuedInitialCwd,
  replayLayoutWithOneShotParkIntent,
  resetTerminalKeyboardProtocolAfterInterrupt,
  retireMountedTerminalPaneSurface,
  shouldDetachPaneTransportOnUnmount,
  splitPaneWithOneShotStartup,
  suppressIntentionalPaneCloseExit
} from './use-terminal-pane-lifecycle'

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
    const clearExitedPanePtyLayoutBindingForLeaf = vi.fn()
    const clearTabPtyId = vi.fn()
    const transport = { detach: vi.fn(), destroy: vi.fn() }

    retireMountedTerminalPaneSurface({
      paneKey: 'legacy-worker:11111111-1111-4111-8111-111111111111',
      leafId: '11111111-1111-4111-8111-111111111111',
      paneId: 2,
      tabId: 'legacy-worker',
      ptyId: 'pty-legacy',
      retireAgentPaneAuthority,
      syncPanePtyLayoutBinding,
      clearExitedPanePtyLayoutBindingForLeaf,
      clearTabPtyId,
      transport
    })

    expect(retireAgentPaneAuthority).toHaveBeenCalledWith(
      'legacy-worker:11111111-1111-4111-8111-111111111111',
      { preserveSleepingAgentSession: true }
    )
    expect(clearExitedPanePtyLayoutBindingForLeaf).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'pty-legacy'
    )
    expect(syncPanePtyLayoutBinding).not.toHaveBeenCalled()
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

// Why: onPaneCreated uses paneOwnsQueuedStartup to decide whether a pane may spend the tab's queued
// startup command. Setup/issue splits borrow the same deps.startup field for their own one-shot
// payload, so a looser test would let a split pane spend a command it never runs — re-breaking
// STA-4876 for split-setup worktrees.
describe('paneOwnsQueuedStartup', () => {
  it('grants ownership only to the pane still holding the queued object', () => {
    const queuedStartup = { command: 'echo queued' }
    const deps: { startup?: { command: string; env?: Record<string, string> } | null } = {
      startup: queuedStartup
    }
    const ownershipAtConnect: boolean[] = []
    const observeConnect = (): void => {
      ownershipAtConnect.push(paneOwnsQueuedStartup(deps.startup, queuedStartup))
    }

    // Primary pane connects first and owns the queued command.
    observeConnect()
    // connectPanePty took it; the lifecycle nulls the outer slot so splits cannot replay it.
    deps.startup = null
    splitPaneWithOneShotStartup(deps, { command: 'orca setup' }, () => {
      observeConnect()
      return { id: 2 }
    })
    splitPaneWithOneShotStartup(deps, { command: 'orca issue' }, () => {
      observeConnect()
      return { id: 3 }
    })

    expect(ownershipAtConnect).toEqual([true, false, false])
  })

  // Why this case matters: a truthiness regression ("has a startup") passes the test above, because
  // the split payload is non-null there too. Only a structurally-identical payload separates them.
  it('denies ownership to a split payload structurally identical to the queued command', () => {
    const queuedStartup = { command: 'orca setup' }

    expect(paneOwnsQueuedStartup({ command: 'orca setup' }, queuedStartup)).toBe(false)
    expect(paneOwnsQueuedStartup(queuedStartup, queuedStartup)).toBe(true)
  })

  it('denies ownership when the tab queued nothing, so an unrelated pane cannot spend a slot', () => {
    expect(paneOwnsQueuedStartup(null, null)).toBe(false)
    expect(paneOwnsQueuedStartup(undefined, undefined)).toBe(false)
    expect(paneOwnsQueuedStartup({ command: 'orca setup' }, null)).toBe(false)
  })
})

describe('createQueuedStartupConsumer', () => {
  it('withholds the consumer from a pane that does not own the queued command', () => {
    const queuedStartup = { command: 'echo queued' }
    const consume = vi.fn()

    // A setup split's borrowed payload, structurally identical to the queued command.
    expect(
      createQueuedStartupConsumer({ command: 'echo queued' }, queuedStartup, consume, () => true)
    ).toBeUndefined()
    expect(createQueuedStartupConsumer(null, queuedStartup, consume, () => true)).toBeUndefined()
    expect(consume).not.toHaveBeenCalled()
  })

  // Why: onPtySpawn fires again on hibernation wake and the respawn ladder. Spending the slot on a
  // later spawn would drop a command queued after the first launch, without ever delivering it.
  it('spends the queued command at most once across repeated spawns', () => {
    const queuedStartup = { command: 'echo queued' }
    const consume = vi.fn()

    const consumer = createQueuedStartupConsumer(queuedStartup, queuedStartup, consume, () => true)
    expect(consumer).toBeTypeOf('function')

    consumer?.()
    consumer?.()
    consumer?.()

    expect(consume).toHaveBeenCalledTimes(1)
  })

  // Why: a replacement can land before this pane's own spawn, so the one-shot guard alone still lets
  // the callback delete a command it never launched (STA-4876).
  it('leaves a command that replaced the captured one queued for its own launch', () => {
    const capturedStartup = { command: 'echo captured' }
    let pending: object | null = capturedStartup
    const consume = vi.fn(() => {
      pending = null
    })

    const consumer = createQueuedStartupConsumer(
      capturedStartup,
      capturedStartup,
      consume,
      () => pending === capturedStartup
    )
    const replacement = { command: 'echo replacement' }
    pending = replacement

    consumer?.()

    expect(consume).not.toHaveBeenCalled()
    expect(pending).toBe(replacement)
  })

  // Why: the replacement belongs to the launch that queued it, so this pane's respawn ladder must not
  // reach for it after skipping its own spent chance.
  it('does not spend a replacement on a later spawn of the same pane', () => {
    const capturedStartup = { command: 'echo captured' }
    let pending: object | null = { command: 'echo replacement' }
    const consume = vi.fn()

    const consumer = createQueuedStartupConsumer(
      capturedStartup,
      capturedStartup,
      consume,
      () => pending === capturedStartup
    )

    consumer?.()
    pending = capturedStartup
    consumer?.()

    expect(consume).not.toHaveBeenCalled()
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

describe('replayLayoutWithOneShotParkIntent', () => {
  it('exposes park intent to replayed panes and clears it before later splits', () => {
    const deps = { mountFollowsTerminalPark: true }
    const observedByReplayedPane: boolean[] = []

    const restored = replayLayoutWithOneShotParkIntent(deps, () => {
      observedByReplayedPane.push(deps.mountFollowsTerminalPark)
      return 'restored-panes'
    })

    expect(restored).toBe('restored-panes')
    expect(observedByReplayedPane).toEqual([true])
    // A split after replay reads the same deps object, so it must see ordinary reconnect semantics.
    expect(deps.mountFollowsTerminalPark).toBe(false)
  })

  it('clears park intent even when layout replay throws', () => {
    const deps = { mountFollowsTerminalPark: true }

    expect(() =>
      replayLayoutWithOneShotParkIntent(deps, () => {
        throw new Error('replay failed')
      })
    ).toThrow('replay failed')

    expect(deps.mountFollowsTerminalPark).toBe(false)
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
