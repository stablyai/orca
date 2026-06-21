import { describe, expect, it, vi } from 'vitest'
import {
  mapRestoredPaneTitlesByPaneId,
  shouldDetachPaneTransportOnUnmount,
  splitPaneWithOneShotStartup,
  suppressIntentionalPaneCloseExit
} from './use-terminal-pane-lifecycle'

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

  it('destroys when the tab is gone and no replacement owns the PTY', () => {
    expect(
      shouldDetachPaneTransportOnUnmount({
        tabStillExists: false,
        tabId: 'tab-1',
        ptyId: 'remote:env@@term-1',
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
