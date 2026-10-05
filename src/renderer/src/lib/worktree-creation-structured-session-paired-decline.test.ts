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

function worktree(name: string): Worktree {
  const worktreePath = path.join('workspace', name)
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
    hostId: 'runtime:server-1',
    runtimeOwnerEnvironmentId: 'server-1'
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
