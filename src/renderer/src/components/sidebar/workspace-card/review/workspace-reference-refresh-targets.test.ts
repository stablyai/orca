// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { getWorkspaceReferenceRefreshTargets } from './workspace-reference-refresh-targets'
import {
  referenceAttachment,
  referenceRepo,
  referenceWorkspace
} from './workspace-reference-fixtures.test-support'
vi.mock('@/store', async () => {
  const browserWindow = globalThis.window
  const { createTestStore } = await import('@/store/github/github-slice-test-harness')
  globalThis.window = browserWindow
  return { useAppStore: createTestStore() }
})
const read = vi.hoisted(() => vi.fn(async () => null))
vi.mock('./workspace-reference-detail-read', () => ({ readWorkspaceReferenceDetails: read }))
const workspace = { ...referenceWorkspace, linkedPR: null, linkedItems: [referenceAttachment()] }
const update = () => getWorkspaceReferenceRefreshTargets(useAppStore.getState())
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAppStore.setState({
    settings: null,
    repos: [referenceRepo],
    worktreesByRepo: { repo: [workspace] },
    detectedWorktreesByRepo: {},
    visibleReviewWorktreeIds: [workspace.id],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all',
    hostedReviewCache: {},
    prCache: {},
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {
      [workspace.id]: [
        {
          id: 'browser',
          worktreeId: workspace.id,
          url: '',
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    sshConnectionStates: new Map()
  })
})
afterEach(() => {
  vi.useRealTimers()
})
it('retains both explicit owners when equal visible workspace IDs exist on two hosts', () => {
  const remoteRepo = {
    ...referenceRepo,
    executionHostId: 'ssh:remote' as const,
    connectionId: 'remote'
  }
  useAppStore.setState({
    repos: [referenceRepo, remoteRepo],
    worktreesByRepo: {
      local: [{ ...workspace, hostId: 'local' }],
      remote: [{ ...workspace, hostId: 'ssh:remote' }]
    },
    sshConnectionStates: new Map([
      ['remote', { targetId: 'remote', status: 'connected', error: null, reconnectAttempt: 0 }]
    ])
  })
  const targets = update()
  expect(targets).toHaveLength(2)
  expect(new Set(targets.map((target) => target.key)).size).toBe(2)
  useAppStore.setState({ visibleWorkspaceHostIds: ['local'] })
  expect(update()).toHaveLength(1)
  useAppStore.setState({
    activeWorktreeId: workspace.id,
    activeWorkspaceExecutionHostId: 'ssh:remote'
  })
  expect(
    getWorkspaceReferenceRefreshTargets(useAppStore.getState(), { selectedOnly: true })
  ).toHaveLength(1)
})
