import { expect, it, vi } from 'vitest'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import {
  type PtyConnectionAgentTitleMocks,
  type PaneConnectionDeps,
  bindPaneAgentTitleMocks
} from './pty-connection-test-deps'
import type { StoreState } from './pty-connection-test-store-state'

type CodexRestartInputLookupFixture = {
  storeState: StoreState
  readonly transportQueue: MockTransport[]
  readonly createDeps: (overrides?: Record<string, unknown>) => PaneConnectionDeps
}

export function registerPtyConnectionCodexRestartInputLookupTests(
  fixture: CodexRestartInputLookupFixture
): void {
  it('does not enumerate every worktree tab for ordinary input without Codex restart notices', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

    const transport = createMockTransport('pty-live')
    fixture.transportQueue.push(transport)
    fixture.storeState = {
      ...fixture.storeState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {}
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = fixture.createDeps()

    connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
    )

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
  })

  it('uses the current worktree tab for Codex stale fallback without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

    const transport = createMockTransport(null)
    fixture.transportQueue.push(transport)
    fixture.storeState = {
      ...fixture.storeState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-other': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = fixture.createDeps()

    connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
    )

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
  })

  it('blocks stale Codex fallback input from the current worktree tab without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')

    const transport = createMockTransport(null)
    fixture.transportQueue.push(transport)
    fixture.storeState = {
      ...fixture.storeState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = fixture.createDeps()

    connectPanePty(
      pane as never,
      manager as never,
      bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
    )

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })
}
