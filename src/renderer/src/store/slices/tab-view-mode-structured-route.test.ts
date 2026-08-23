/**
 * Both ways into structured chat go through one door.
 *
 * Right-click → "Switch to chat" and launching a Codex tab with open-in-chat both end at
 * `setTabViewMode(tabId, 'chat')`, which hands a terminal tab to `setTerminalNativeChatMode` and
 * from there to `agentSession.adoptTerminal`. Pinning that here is what makes "launch-at-chat
 * shares the adoption defect" a checked claim rather than an inspection of the call graph.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeUnifiedTab, makeTabGroup } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const runtimeCall = vi.fn()

const mockApi = {
  ui: { set: vi.fn().mockResolvedValue(undefined) },
  settings: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
  runtime: { call: runtimeCall }
}

// @ts-expect-error -- partial window stub is sufficient for these store-only tests
globalThis.window = { api: mockApi }

const WT = 'repo1::/tmp/feature'

describe('structured chat route out of setTabViewMode', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    let handoffStarted = false
    runtimeCall.mockReset()
    runtimeCall.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'agentSession.adoptTerminal') {
        return { ok: true, result: { ok: true, fence: 1 } }
      }
      if (method === 'agentSession.handoff') {
        handoffStarted = true
        return { ok: true, result: { ok: true } }
      }
      if (method === 'agentSession.handoffStatus') {
        return {
          ok: true,
          result: handoffStarted
            ? { owner: 'native', direction: null, phase: 'idle' }
            : { owner: 'tui', direction: null, phase: 'idle' }
        }
      }
      throw new Error(`Unexpected runtime method: ${method}`)
    })
    store = createTestStore()
    store.setState({
      activeRepoId: 'repo1',
      activeWorktreeId: WT,
      projects: [{ id: 'repo1' }],
      repos: [{ id: 'repo1', path: '/tmp/repo', connectionId: null }],
      worktreesByRepo: {
        repo1: [{ id: WT, repoId: 'repo1', path: '/tmp/feature', hostId: 'local' }]
      },
      detectedWorktreesByRepo: {},
      settings: {},
      unifiedTabsByWorktree: {
        [WT]: [makeUnifiedTab({ id: 'codex-tab', worktreeId: WT, groupId: 'g-1' })]
      },
      tabsByWorktree: { [WT]: [{ id: 'codex-tab', launchAgent: 'codex' }] },
      terminalLayoutsByTabId: {
        'codex-tab': {
          activeLeafId: 'leaf-adopt',
          ptyIdsByLeafId: { 'leaf-adopt': 'pty-adopt' }
        }
      },
      agentStatusByPaneKey: {
        'codex-tab:leaf-adopt': {
          agentType: 'codex',
          providerSession: { id: 'thread-adopt' }
        }
      },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: 'g-1',
            worktreeId: WT,
            activeTabId: 'codex-tab',
            tabOrder: ['codex-tab']
          })
        ]
      }
    } as unknown as Partial<AppState>)
  })

  it('hands an explicit chat mode to the structured adoption path', async () => {
    store.getState().setTabViewMode('codex-tab', 'chat')

    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'agentSession.adoptTerminal' })
      )
    )
  })

  it('hands a toggled chat mode to the same path', async () => {
    store.getState().toggleTabViewMode('codex-tab')

    await vi.waitFor(() =>
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'agentSession.adoptTerminal' })
      )
    )
  })
})
