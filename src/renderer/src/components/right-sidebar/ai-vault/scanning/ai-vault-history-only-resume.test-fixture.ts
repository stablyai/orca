import { expect } from 'vitest'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { resolveTerminalPaneOwnerContext } from '../../../terminal-pane/host-state/terminal-pane-owner-context'
import { resolveTerminalWorktreeRoute } from '@/lib/workspace/ownership/terminal-worktree-route'
import { createIpcPtyTransport } from '../../../terminal-pane/pty-transport/ipc/pty-transport'
import { useAppStore } from '@/store/index'
import { resolveAiVaultSessionRowChatActions } from '../session-actions/ai-vault-session-chat-action'
import type { ComponentProps } from 'react'
import type { AiVaultSessionVirtualList } from '../session-list/AiVaultSessionVirtualList'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { toDetectedWorktree } from '../../../../../../shared/worktree/visibility/ownership'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { searchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { aiVaultSearchHitToSession } from '../search/ai-vault-search-session'
import { stoppedWorkspaceListing } from '../../../retained-bare-workspace.test-fixture'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'

export const bareId = 'repo-1::/repo/.bare'
export const checkoutId = 'repo-1::/repo/checkout'
export const nativeId = 'native-history-only'
export const settings = getDefaultSettings('/tmp')
export const repo: Repo = { ...makeRepo(), path: '/repo/.bare', executionHostId: 'local' }
export const bare = toDetectedWorktree({
  repo,
  worktree: makeWorktree(bareId, 'Original storage', {
    path: '/repo/.bare',
    isBare: true,
    hostId: 'local'
  }),
  settings,
  knownOrcaLayouts: []
})
export const checkout = makeWorktree(checkoutId, 'Checkout', {
  path: '/repo/checkout',
  hostId: 'local'
})

export function publishStoppedHistoryListing(): void {
  const fallback = stoppedWorkspaceListing(repo, [bare, checkout])
  expect(fallback.worktrees.find((row) => row.id === bareId)).toMatchObject({
    id: bareId,
    path: bare.path,
    hostId: 'local',
    isBare: false
  })
  expect(
    mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
      repoId: repo.id,
      hostId: 'local',
      ownerWasMissingAtStart: false,
      requestStartedWorktrees: useAppStore.getState().worktreesByRepo[repo.id],
      refresh: { status: 'admitted', executionHostId: 'local', result: fallback }
    })
  ).toBe('applied')
  expect(useAppStore.getState().worktreesByRepo[repo.id]).toEqual([checkout])
  expect(useAppStore.getState().tabsByWorktree).toEqual({})
  expect(useAppStore.getState().unifiedTabsByWorktree).toEqual({})
  expect(useAppStore.getState().browserTabsByWorktree).toEqual({})
}

export function session(sessionId: string, cwd: string, title: string): AiVaultSession {
  return aiVaultSearchHitToSession(
    {
      ...searchHit(),
      agent: 'codex',
      sessionId,
      cwd,
      title,
      source: {
        presence: 'present',
        filePath: `/history/${sessionId}.jsonl`
      }
    },
    'local'
  )
}

export function inventory(revealed: boolean): RuntimeMobileSessionTabsResult {
  return {
    worktree: bareId,
    publicationEpoch: 'history-only-reopen',
    snapshotVersion: revealed ? 2 : 1,
    activeGroupId: revealed ? 'native-group' : null,
    activeTabId: revealed ? `agent-session:${nativeId}` : null,
    activeTabType: revealed ? 'agent-session' : null,
    tabGroups: revealed
      ? [
          {
            id: 'native-group',
            activeTabId: `agent-session:${nativeId}`,
            tabOrder: [`agent-session:${nativeId}`]
          }
        ]
      : [],
    tabs: revealed
      ? [
          {
            type: 'agent-session',
            id: `agent-session:${nativeId}`,
            sessionId: nativeId,
            title: 'Original native conversation',
            agent: 'codex',
            isActive: true
          }
        ]
      : []
  }
}

export function historyResumeRowActions(
  session: AiVaultSession,
  props: Pick<
    ComponentProps<typeof AiVaultSessionVirtualList>,
    'getSessionResumeState' | 'getSessionResumeInChat'
  >,
  targets: Record<string, string | null>
) {
  const resumeState = props.getSessionResumeState(session)
  targets[session.id] = resumeState.worktreeId
  return resolveAiVaultSessionRowChatActions({
    session,
    originalPaneTarget: null,
    structuredSessionOpen: false,
    resumeState,
    resumeInChat: props.getSessionResumeInChat(session),
    searchHit: undefined
  })
}

export function expectHistoryCliStartup(workspaceId: string, cwd: string, providerId: string) {
  const [created] = useAppStore.getState().tabsByWorktree[workspaceId]
  expect(created.startupCwd).toBe(cwd)
  expect(useAppStore.getState().pendingStartupByTabId[created.id]).toMatchObject({
    command: expect.stringContaining(providerId),
    resumeProviderSession: { key: 'session_id', id: providerId },
    telemetry: { request_kind: 'resume' }
  })
  return created
}

export function installHistoryHostTwin(executionHostId: 'local' | 'ssh:target-1'): void {
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'runtime:other',
    repos: [
      { ...repo, executionHostId, connectionId: executionHostId === 'local' ? null : 'target-1' }
    ],
    worktreesByRepo: {
      [repo.id]: [{ ...checkout, id: bareId, path: bare.path, hostId: 'runtime:other' }, checkout]
    },
    detectedWorktreesByRepo: {
      [repo.id]: {
        repoId: repo.id,
        source: 'git',
        authoritative: true,
        worktrees: [
          { ...bare, isBare: false, hostId: 'runtime:other' },
          { ...bare, hostId: executionHostId }
        ]
      }
    }
  })
}

/** Exercise the real pane owner and IPC transport from the tab's atomic publication. */
export function connectHistoryCliPane(state: AppState, tab: TerminalTab) {
  const owner = resolveTerminalPaneOwnerContext(
    state,
    tab.worktreeId,
    tab.id,
    resolveTerminalWorktreeRoute(state, tab.worktreeId)
  )
  const startup = state.pendingStartupByTabId[tab.id]
  const transport = createIpcPtyTransport({
    connectionId: owner.connectionId,
    executionHostId: owner.executionHostId,
    cwd: tab.startupCwd,
    shellOverride: tab.shellOverride,
    worktreeId: tab.worktreeId,
    tabId: tab.id,
    leafId: state.terminalLayoutsByTabId[tab.id]?.activeLeafId ?? undefined,
    command: startup?.command,
    env: startup?.env,
    envToDelete: startup?.envToDelete,
    launchConfig: startup?.launchConfig,
    resumeProviderSession: startup?.resumeProviderSession,
    telemetry: startup?.telemetry
  })
  const connected = transport.connect({ url: '', callbacks: {} })
  return { owner, transport, connected }
}
