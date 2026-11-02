// @vitest-environment happy-dom

import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const mocks = vi.hoisted(() => {
  const mainStarts: unknown[] = []
  return {
    createSupport: vi.fn(),
    // Whether the owning host accepts a new workspace's launch and owns its Setup wait.
    hostAccepts: false,
    hostLaunch: vi.fn(
      (_method: string, _params: unknown): Promise<unknown> => new Promise(() => {})
    ),
    mainStarts
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mocks.createSupport() : new Promise(() => undefined)
  ),
  structuredAgentSessionHostSupports: async () => mocks.hostAccepts
}))

import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'
import { pendingCreationChatDraftScopeKey } from './pending-worktree-creation'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'

// Main's answer to the window's layout commands, as a switch-on build sends them, and the first
// terminals it starts for the window's new tabs.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
      if (args[1].startsWith('agent.launch')) {
        return mocks.hostLaunch(args[1], args[2])
      }
      if (args[1] !== 'terminal.create') {
        return client.callRuntimeRpc(...args)
      }
      mocks.mainStarts.push(args[2])
      return new Promise(() => undefined)
    }
  }
})

/** The startup the tab's terminal runs: main's start in a layout-owner build, else the window's. */
function startupOf(tabId: string): unknown {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return useAppStore.getState().pendingStartupByTabId[tabId]
  }
  return mocks.mainStarts.find(
    (params) =>
      typeof params === 'object' && params !== null && 'tabId' in params && params.tabId === tabId
  )
}

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
  mocks.hostAccepts = false
  mocks.hostLaunch.mockReset()
  mocks.mainStarts.length = 0
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
    expect(startupOf(tab.id)).toMatchObject({
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

describe('a background create whose own machine owns its Setup and cannot run the chat', () => {
  const TERMINAL_TAB = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

  it.each([
    ['nothing else was typed', '', 0],
    ['a follow-up was left unsent', 'Also run lint', 1]
  ])("puts the host's terminal where the chat was when %s", async (_case, unsent, chatsLeft) => {
    mocks.hostAccepts = true
    const status = Promise.withResolvers<unknown>()
    mocks.hostLaunch.mockImplementation(async (method) =>
      method === 'agent.launchAccept' ? { state: 'running' } : status.promise
    )
    seedThisMachine()
    updateNativeChatComposerDraft(
      pendingCreationChatDraftScopeKey('creation-1'),
      { text: unsent, images: [] },
      'immediate'
    )

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
      expect(mocks.hostLaunch).toHaveBeenCalledWith('agent.launchStatus', expect.anything())
    )
    const chatsNow = () =>
      (useAppStore.getState().unifiedTabsByWorktree[LOCAL_CREATED.id] ?? []).filter(
        (candidate) => candidate.contentType === 'agent-session'
      )
    // Until Setup ends only the chat shows, and the window starts no terminal of its own.
    expect(chatsNow()).toHaveLength(1)
    expect(useAppStore.getState().tabsByWorktree[LOCAL_CREATED.id] ?? []).toEqual([])
    const [, accepted] = mocks.hostLaunch.mock.calls[0]!
    expect(accepted).toMatchObject({
      presentation: 'background',
      prompt: { text: 'fix the flaky test', delivery: 'submit' },
      terminalStartup: {
        command: "claude --model opus 'fix the flaky test'",
        promptDelivery: 'draft'
      }
    })

    // The host's terminal reaches this window, then the host says that is what it started.
    useAppStore.getState().createTab(LOCAL_CREATED.id, undefined, undefined, {
      id: TERMINAL_TAB
    })
    status.resolve({
      state: 'succeeded',
      result: {
        outcome: {
          kind: 'terminal',
          handle: 'term_1',
          paneKey: `${TERMINAL_TAB}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`
        },
        worktreeId: LOCAL_CREATED.id,
        receipt: {
          mode: 'terminal',
          preferred: 'structured',
          reason: 'structured_unsupported_on_host',
          detail: ''
        },
        prompt: { delivery: 'draft', outcome: 'not-delivered' }
      }
    })

    await vi.waitFor(() => expect(chatsNow()).toHaveLength(chatsLeft))
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[LOCAL_CREATED.id]?.map((tab) => tab.id)).toEqual([TERMINAL_TAB])
    expect(state.pendingStartupByTabId[TERMINAL_TAB]).toBeUndefined()
    if (chatsLeft) {
      // The chat keeps what was typed in it, right beside the terminal that replaced its start.
      const chat = chatsNow()[0]!
      const order = state.groupsByWorktree[LOCAL_CREATED.id]?.find(
        (group) => group.id === chat.groupId
      )?.tabOrder
      expect(order?.indexOf(TERMINAL_TAB)).toBe((order?.indexOf(chat.id) ?? -2) + 1)
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(chat.entityId)).text
      ).toBe(unsent)
    }
    expect(mocks.hostLaunch.mock.calls.map(([method]) => method)).not.toContain('agent.launch')
    expect(state.activeWorktreeId).toBe(LOCAL_OTHER.id)
  })
})
