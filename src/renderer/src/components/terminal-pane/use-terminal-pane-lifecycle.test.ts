import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setActiveTerminalOutputTarget: vi.fn()
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  setActiveTerminalOutputTarget: mocks.setActiveTerminalOutputTarget
}))

import {
  reportActiveRendererPtyForPane,
  shouldDetachPaneTransportOnUnmount,
  splitPaneWithOneShotStartup,
  suppressIntentionalPaneCloseExit
} from './use-terminal-pane-lifecycle'

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      pty: {
        setActiveRendererPty: vi.fn()
      }
    }
  }
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

describe('reportActiveRendererPtyForPane', () => {
  it('marks the active visible pane as the renderer output target', () => {
    const terminalA = { name: 'terminal-a' }
    const terminalB = { name: 'terminal-b' }
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: terminalA },
        { id: 2, terminal: terminalB }
      ])
    }
    const paneTransports = new Map([
      [1, { getPtyId: vi.fn(() => 'pty-1') }],
      [2, { getPtyId: vi.fn(() => 'remote:env@@pty-2') }]
    ])

    reportActiveRendererPtyForPane(paneTransports as never, manager as never, 2, true)

    expect(mocks.setActiveTerminalOutputTarget).toHaveBeenCalledWith(terminalA, false)
    expect(mocks.setActiveTerminalOutputTarget).toHaveBeenCalledWith(terminalB, true)
    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-1', false)
    expect(window.api.pty.setActiveRendererPty).not.toHaveBeenCalledWith(
      'remote:env@@pty-2',
      expect.anything()
    )
  })

  it('clears every renderer output target while hidden or inactive', () => {
    const terminalA = { name: 'terminal-a' }
    const terminalB = { name: 'terminal-b' }
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: terminalA },
        { id: 2, terminal: terminalB }
      ])
    }
    const paneTransports = new Map([
      [1, { getPtyId: vi.fn(() => 'pty-1') }],
      [2, { getPtyId: vi.fn(() => 'pty-2') }]
    ])

    reportActiveRendererPtyForPane(paneTransports as never, manager as never, 2, false)

    expect(mocks.setActiveTerminalOutputTarget).toHaveBeenCalledWith(terminalA, false)
    expect(mocks.setActiveTerminalOutputTarget).toHaveBeenCalledWith(terminalB, false)
    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-1', false)
    expect(window.api.pty.setActiveRendererPty).toHaveBeenCalledWith('pty-2', false)
  })
})
