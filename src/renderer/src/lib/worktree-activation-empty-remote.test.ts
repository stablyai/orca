import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Worktree } from '../../../shared/worktree/types'
import { resetWebRuntimeWakeTerminalRespawnForTests } from '@/runtime/web-runtime-wake-terminal-respawn'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync'
import { useAppStore } from '@/store'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from './web-runtime-worktree-terminal-after-wake'

const initialAppStoreState = useAppStore.getState()
const WORKTREE_PATH = path.join('workspace', 'feature')
const REPO_PATH = path.join('workspace', 'repo')
const ORCA_WORKSPACES_PATH = path.join('workspace', '.orca-workspaces')

afterEach(() => {
  delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  vi.unstubAllGlobals()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetWebRuntimeWakeTerminalRespawnForTests()
  useAppStore.setState(initialAppStoreState, true)
})

function makeWorktree(): Worktree {
  return {
    id: `repo-1::${WORKTREE_PATH}`,
    repoId: 'repo-1',
    path: WORKTREE_PATH,
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
    createdWithAgent: 'codex',
    hostId: 'local',
    runtimeOwnerEnvironmentId: 'web-runtime-1'
  }
}

describe('empty remote worktree activation', () => {
  it.each(['unopened', 'closed-last-tab'])(
    'keeps a %s remote workspace empty on repeated activation',
    async (kind) => {
      const worktree = makeWorktree()
      const callRuntimeEnvironment = vi.fn().mockResolvedValue({ ok: true, result: {} })
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
            path: REPO_PATH,
            displayName: 'repo',
            badgeColor: '#000000',
            addedAt: 0
          }
        ],
        worktreesByRepo: { 'repo-1': [worktree] },
        tabsByWorktree: kind === 'closed-last-tab' ? { [worktree.id]: [] } : {},
        ptyIdsByTabId: {},
        settings: {
          ...getDefaultSettings(ORCA_WORKSPACES_PATH),
          activeRuntimeEnvironmentId: 'web-runtime-1'
        },
        reconcileWorktreeTabModel: vi.fn(() => ({
          renderableTabCount: 0,
          activeRenderableTabId: null
        }))
      })

      ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
      ensureWebRuntimeWorktreeTerminalAfterWake(worktree.id)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(callRuntimeEnvironment).not.toHaveBeenCalled()
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
    }
  )
})
