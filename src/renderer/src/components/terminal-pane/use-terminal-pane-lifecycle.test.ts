import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalScrollbackRowsToMountedPanes,
  clearQueuedInitialCwdAfterFirstPane,
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume,
  mapRestoredPaneTitlesByPaneId,
  resolvePaneLinkCwd,
  resolvePaneSeedCwd,
  resolveQueuedInitialCwd,
  resetTerminalKeyboardProtocolAfterInterrupt,
  shouldDetachPaneTransportOnUnmount,
  splitPaneWithOneShotStartup,
  suppressIntentionalPaneCloseExit
} from './use-terminal-pane-lifecycle'

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
