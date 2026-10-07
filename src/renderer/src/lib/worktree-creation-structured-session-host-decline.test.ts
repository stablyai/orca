// @vitest-environment happy-dom

import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const mocks = vi.hoisted(() => ({ createSupport: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mocks.createSupport() : new Promise(() => undefined)
  )
}))

import { useAppStore } from '@/store'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

const initial = useAppStore.getState()

function worktree(name: string, host: 'paired' | 'local' = 'paired'): Worktree {
  const worktreePath = path.join('workspace', name)
  const owner: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'> =
    host === 'paired'
      ? { hostId: 'runtime:server-1', runtimeOwnerEnvironmentId: 'server-1' }
      : { hostId: 'local' }
  return {
    id: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    path: worktreePath,
    head: 'abc',
    branch: `refs/heads/${name}`,
    isBare: false,
    isMainWorktree: false,
    displayName: name,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdWithAgent: 'claude',
    ...owner
  }
}

const OTHER = worktree('other')
const CREATED = worktree('created')

function seedPairedServer(): ReturnType<typeof vi.fn> {
  const call = vi.fn(() => new Promise(() => undefined))
  vi.stubGlobal('window', { ...window, api: { runtimeEnvironments: { call, subscribe: vi.fn() } } })
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: path.join('workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'runtime:server-1'
      }
    ],
    worktreesByRepo: { 'repo-1': [OTHER, CREATED] },
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only checks the creation is still pending.
    pendingWorktreeCreations: { 'creation-1': {} as never },
    settings: {
      ...getDefaultSettings(path.join('workspace', '.orca')),
      activeRuntimeEnvironmentId: 'server-1'
    }
  })
  // The user moved to another workspace while the create ran.
  useAppStore.getState().setActiveWorktree(OTHER.id, 'runtime:server-1')
  return call
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these request fields.
const REQUEST = {
  agent: 'claude',
  quickPrompt: 'fix the flaky test',
  promptDelivery: 'auto-submit',
  startupPlan: {
    launchCommand: "claude --model opus 'fix the flaky test'",
    launchConfig: { agent: 'claude' }
  }
} as unknown as WorktreeCreationRequest

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

describe('a background worktree create whose paired server declines the chat', () => {
  it("opens the request's agent terminal without pulling the user onto the new workspace", async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const call = seedPairedServer()

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: REQUEST,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: CREATED.id,
      shouldActivateOnCompletion: false,
      activation: false,
      primaryTabId: null
    })

    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'session.tabs.createTerminal',
          params: expect.objectContaining({
            command: "claude --model opus 'fix the flaky test'",
            select: false
          })
        })
      )
    )
    expect(useAppStore.getState().activeWorktreeId).toBe(OTHER.id)
  })
})

const LOCAL_OTHER = worktree('local-other', 'local')
const LOCAL_CREATED = worktree('local-created', 'local')

function seedThisMachine(): void {
  useAppStore.setState({
    repos: [
      {
        id: 'repo-1',
        path: path.join('workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [LOCAL_OTHER, LOCAL_CREATED] },
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch only checks the creation is still pending.
    pendingWorktreeCreations: { 'creation-1': {} as never },
    settings: getDefaultSettings(path.join('workspace', '.orca')),
    // The user moved to another workspace while the create ran.
    activeWorktreeId: LOCAL_OTHER.id
  })
}

describe('a background worktree create whose own machine declines the chat', () => {
  it("opens the request's agent terminal in place, with no chat, leaving the user where they are", async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    seedThisMachine()

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: REQUEST,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: LOCAL_CREATED.id,
      shouldActivateOnCompletion: false,
      activation: false,
      primaryTabId: null
    })

    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[LOCAL_CREATED.id]).toHaveLength(1)
    )
    const state = useAppStore.getState()
    const tab = state.tabsByWorktree[LOCAL_CREATED.id]![0]!
    expect(state.pendingStartupByTabId[tab.id]).toMatchObject({
      command: "claude --model opus 'fix the flaky test'"
    })
    expect(
      (state.unifiedTabsByWorktree[LOCAL_CREATED.id] ?? []).filter(
        (candidate) => candidate.contentType === 'agent-session'
      )
    ).toEqual([])
    expect(state.activeWorktreeId).toBe(LOCAL_OTHER.id)
  })
})
