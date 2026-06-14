import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Worktree } from '../../../shared/types'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync'
import { useAppStore } from '@/store'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/workspace/feature',
    repoId: 'repo-1',
    path: '/workspace/feature',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdWithAgent: 'codex'
  }
}

describe('empty remote worktree activation', () => {
  it('creates a host terminal when waking an empty remote workspace', async () => {
    const worktree = makeWorktree()
    const callRuntimeEnvironment = vi.fn().mockResolvedValueOnce({
      ok: true,
      result: {
        tab: {
          type: 'terminal',
          id: 'host-tab-1::leaf-1',
          parentTabId: 'host-tab-1',
          leafId: 'leaf-1',
          title: 'Terminal 1',
          terminal: 'term_host',
          status: 'ready',
          isActive: true
        },
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1
      }
    })
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: callRuntimeEnvironment,
          subscribe: vi.fn()
        }
      }
    })

    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: { 'repo-1': [worktree] },
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      settings: {
        ...getDefaultSettings('/workspace/.orca-workspaces'),
        activeRuntimeEnvironmentId: 'web-runtime-1'
      },
      reconcileWorktreeTabModel: vi.fn(() => ({
        renderableTabCount: 0,
        activeRenderableTabId: null
      }))
    })

    ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'web-runtime-1',
        method: 'session.tabs.createTerminal',
        params: expect.objectContaining({
          worktree: `id:${worktree.id}`,
          activate: true
        })
      })
    )
  })
})
