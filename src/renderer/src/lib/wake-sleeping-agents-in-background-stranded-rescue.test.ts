import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT,
  type BackgroundMountTerminalWorktreeDetail
} from '@/constants/terminal'
import { wakeSleepingAgentsForWorktreeInBackground } from './wake-sleeping-agents-in-background'
import { makeCreatedAgentWorktree as makeWorktree } from '@/lib/worktree-activation-created-agent-test-state'

vi.mock('../hooks/remote-workspace-snapshot-apply', () => ({
  isDirectSshRemoteWorkspaceApplyInProgress: vi.fn(() => false)
}))

const initialAppStoreState = useAppStore.getState()

// Why: this suite exercises the real window.dispatchEvent/addEventListener path the source
// hits (unlike the sibling test file, which fully mocks the store); Node's built-in EventTarget
// gives that without pulling in the happy-dom environment, whose asset-URL resolution the
// scratchpad's missing binary pet-model assets can't satisfy.
function stubEventCapableWindow(): void {
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      api: { session: { get: vi.fn().mockResolvedValue({ tabsByWorktree: {} } as never) } }
    })
  )
}

function baseState(worktree: ReturnType<typeof makeWorktree>): Partial<AppState> {
  return {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings']
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('wakeSleepingAgentsForWorktreeInBackground stranded rescue', () => {
  it('background-mounts the rescued tab once the real stranded-rescue sweep launches it', async () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    useAppStore.setState(baseState(worktree))
    stubEventCapableWindow()
    const paneKey = 'stranded-pane:0'
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: 'stranded-pane',
          worktreeId: worktree.id,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-stranded' },
          prompt: 'resume prior task',
          state: 'working',
          origin: 'live',
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    const mountedTabIds: string[] = []
    const onMount = (event: Event): void => {
      const detail = (event as CustomEvent<BackgroundMountTerminalWorktreeDetail>).detail
      if (detail.worktreeId === worktree.id) {
        mountedTabIds.push(...(detail.tabIds ?? []))
      }
    }
    window.addEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)

    wakeSleepingAgentsForWorktreeInBackground(worktree.id)

    // The stranded record has no live tab anywhere, so window.api.session.get resolves before
    // resumeSleepingAgentSessionsForWorktree can launch it synchronously — the launch (and its
    // mount) only happens once that async rescue concludes.
    await vi.waitFor(() => {
      expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(1)
    })
    const launchedTabId = useAppStore.getState().tabsByWorktree[worktree.id]![0]!.id

    window.removeEventListener(BACKGROUND_MOUNT_TERMINAL_WORKTREE_EVENT, onMount)
    // Why: the rescued tab is created with activate:false, so nothing else mounts it — without
    // this dispatch its queued --resume startup never reaches a PTY.
    expect(mountedTabIds).toContain(launchedTabId)
  })
})
