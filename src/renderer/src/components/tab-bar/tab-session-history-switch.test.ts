import { makeTabSessionHistoryRow as row } from './tab-session-history-test-fixture'
import { applyProviderSessionOnlyUpdate } from '@/hooks/ipc-events/agent-status-partial-updates'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeRepo, makeTerminalTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { makeAgentStatusEntry } from '@/runtime/sync-runtime-graph-test-harness'
import { collectAiVaultTitleRequests } from '@/lib/ai-vault-tab-title-requests'
import { resolveCliChatResumeSource } from './cli-chat-resume-source'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import type { AiVaultListArgs, AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  claimAiVaultForcedRescan,
  resetAiVaultForcedRescanThrottleForTest
} from '../right-sidebar/ai-vault-session-refresh'
import {
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList
} from '../right-sidebar/ai-vault-session-list-request'
import {
  canPaneOfferResumeInNewChat,
  findTabSessionHistoryRow,
  lookupTabSessionHistoryRow,
  resolveTabSessionHistorySubject,
  resolveNativeChatCliForkIdentity,
  resolveTabSessionSwitch,
  type TabSessionHistorySubject
} from './tab-session-history-switch'

const mocks = vi.hoisted(() => {
  const state: {
    resumeState: { blocked: boolean; worktreeId: string | null }
    platform: string
  } = { resumeState: { blocked: false, worktreeId: 'repo-1::/repo/wt' }, platform: 'darwin' }
  return { ...state, resumeInChat: vi.fn() }
})

// Staged host answers: its capabilities arrive over IPC at boot, and the platform from preload.
vi.mock('@/runtime/local-runtime-capabilities', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}))
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readHostStructuredAgents: () =>
    ['claude', 'codex', 'grok', 'omp', 'opencode', 'pi'].map((agent) => ({
      agent,
      capabilities: {}
    }))
}))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => mocks.platform }))

// Parity with the panel's real composition is pinned in tab-session-history-switch.parity.test.ts.
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-workspace', () => ({
  resolveAiVaultHistoryRowResume: () => ({
    resumeState: { ...mocks.resumeState, usesSessionWorktree: true },
    resumeInChat: mocks.resumeInChat()
  })
}))

const WORKTREE_ID = 'repo-1::/repo/wt'

const SIBLING_ID = 'repo-1::/repo/sibling'

function makeState(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'] = {},
  repo: Partial<ReturnType<typeof makeRepo>> = {}
): AppState {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey,
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE_ID,
    repos: [{ ...makeRepo(), ...repo }],
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTerminalTab('term-1', WORKTREE_ID, 'claude')]
    },
    worktreesByRepo: {
      'repo-1': [
        makeWorktree(WORKTREE_ID, 'wt', { path: '/repo/wt' }),
        makeWorktree(SIBLING_ID, 'sibling', { path: '/repo/sibling' })
      ]
    }
  })
  return useAppStore.getState()
}

const PANEL_REQUEST = {
  scopePaths: ['/repo/wt'],
  executionHostScope: 'local',
  sessionLimit: 250
} as const

const liveClaudeEntry = {
  'term-1:leaf-1': makeAgentStatusEntry({
    agentType: 'claude',
    paneKey: 'term-1:leaf-1',
    tabId: 'term-1',
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'claude-session-1' }
  })
}

const chatSubject: TabSessionHistorySubject = {
  kind: 'chat',
  sessionId: 'orca-chat-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}

const cliSubject: TabSessionHistorySubject = {
  kind: 'cli',
  agent: 'claude',
  providerSessionId: 'claude-session-1',
  workspaceId: WORKTREE_ID,
  request: PANEL_REQUEST
}

beforeEach(() => {
  resetAiVaultForcedRescanThrottleForTest()
  mocks.resumeState = { blocked: false, worktreeId: WORKTREE_ID }
  mocks.platform = 'darwin'
  mocks.resumeInChat.mockReset()
})

// What Orca remembers once the agent exits and the pane is back at its shell prompt.
const exitedAgentRecords: Record<string, Partial<AppState>> = {
  retained: {
    retainedAgentsByPaneKey: {
      'term-1:leaf-1': {
        entry: liveClaudeEntry['term-1:leaf-1'],
        worktreeId: WORKTREE_ID,
        tab: makeTerminalTab('term-1', WORKTREE_ID, 'claude'),
        agentType: 'claude',
        startedAt: 1
      }
    }
  },
  sleeping: {
    sleepingAgentSessionsByPaneKey: {
      'term-1:leaf-1': {
        paneKey: 'term-1:leaf-1',
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }
}

describe('resolveTabSessionHistorySubject', () => {
  it('retains the chosen pane in the direct CLI create identity without a History row', () => {
    expect(
      resolveCliChatResumeSource(makeState(liveClaudeEntry), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toMatchObject({
      tabId: 'term-1',
      workspaceId: WORKTREE_ID,
      paneKey: 'term-1:leaf-1',
      agent: 'claude',
      providerSessionId: 'claude-session-1',
      executionHostId: 'local'
    })
  })
  it.each([
    [true, 'git'],
    [false, 'git'],
    [true, 'folder'],
    [false, 'folder']
  ] as const)(
    'offers remote CLI continuation only with history support %s in %s workspaces',
    (supported, kind) => {
      const state = makeState(liveClaudeEntry, { executionHostId: 'runtime:server-1' })
      const workspaceId = kind === 'folder' ? folderWorkspaceKey('folder-1') : WORKTREE_ID
      if (kind === 'folder') {
        state.folderWorkspaces = [
          makeFolderWorkspace({
            id: 'folder-1',
            folderPath: '/repo/wt',
            executionHostId: 'runtime:server-1'
          })
        ]
        state.activeWorktreeId = workspaceId
        state.activeWorkspaceExecutionHostId = 'runtime:server-1'
        state.tabsByWorktree = { [workspaceId]: [makeTerminalTab('term-1', workspaceId, 'claude')] }
        state.agentStatusByPaneKey = {
          'term-1:leaf-1': { ...liveClaudeEntry['term-1:leaf-1'], worktreeId: workspaceId }
        }
      }

      state.runtimeStatusByEnvironmentId = new Map([
        [
          'server-1',
          {
            checkedAt: 1,
            status: {
              runtimeId: 'server-runtime',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 1,
              liveLeafCount: 1,
              capabilities: [
                STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
                STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
                STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
                ...(supported ? [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY] : [])
              ]
            }
          }
        ]
      ])
      const source = resolveCliChatResumeSource(state, {
        tab: { id: 'term-1', worktreeId: workspaceId }
      })
      if (supported) {
        expect(source).toMatchObject({
          executionHostId: 'runtime:server-1',
          providerSessionId: 'claude-session-1',
          paneKey: 'term-1:leaf-1'
        })
        expect(source?.hostUpdateRequired).toBeUndefined()
      } else {
        // A verified host without resume-history keeps the action, disabled, asking for an update.
        expect(source).toMatchObject({ hostUpdateRequired: true })
      }
    }
  )

  it.each(['runtime:server-1', 'ssh:dev-box'] as const)(
    'does not offer unsupported or unprobed host %s',
    (executionHostId) => {
      const state = makeState(liveClaudeEntry, { executionHostId })
      expect(
        resolveCliChatResumeSource(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
    }
  )

  it.each(['local', 'runtime:server-1', 'ssh:dev-box', null] as const)(
    'keeps lightweight native eligibility and the public request on workspace host %s',
    (executionHostId) => {
      const state = makeState({}, executionHostId ? { executionHostId } : {})
      if (!executionHostId) {
        state.repos = []
      }
      const args = {
        tab: { id: 'chat-tab', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'chat-1', agent: 'claude' as const }
      }
      const expected = executionHostId === 'ssh:dev-box' ? null : executionHostId
      const identity = resolveNativeChatCliForkIdentity(state, args)
      const full = resolveTabSessionHistorySubject(state, args)
      expect(identity?.executionHostScope ?? null).toBe(expected)
      expect(full?.request.executionHostScope ?? null).toBe(expected)
    }
  )

  it('finds a native chat tab by the chat it shows', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(), {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'codex' }
      })
    ).toEqual({ ...chatSubject })
  })

  it.each(['grok', 'opencode', 'omp'] as const)(
    'finds a %s chat, whose conversation can be copied to its CLI',
    (agent) => {
      expect(
        resolveTabSessionHistorySubject(makeState(), {
          tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
          nativeChat: { sessionId: 'orca-chat-1', agent }
        })
      ).toEqual({ ...chatSubject })
    }
  )

  it('finds a terminal tab by the conversation its agent reported', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(liveClaudeEntry), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toEqual(cliSubject)
  })

  it('finds an agent a restart reattached to before it reports again', () => {
    const [[paneKey, entry]] = Object.entries(liveClaudeEntry)
    expect(
      resolveTabSessionHistorySubject(
        makeState({ [paneKey]: { ...entry, restoredUnconfirmed: true } }),
        { tab: { id: 'term-1', worktreeId: WORKTREE_ID } }
      )
    ).toEqual(cliSubject)
  })

  it.each(Object.keys(exitedAgentRecords))(
    'offers nothing from a %s record once the agent has exited, though the tab title keeps it',
    (kind) => {
      makeState()
      useAppStore.setState(exitedAgentRecords[kind])
      const state = useAppStore.getState()
      expect(
        resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
      expect(collectAiVaultTitleRequests(state)).toEqual([
        expect.objectContaining({
          tabId: 'term-1',
          providerSession: { key: 'session_id', id: 'claude-session-1' }
        })
      ])
    }
  )

  it("prefers a split pane's running agent over the focused pane's exited one", () => {
    makeState({
      'term-1:leaf-2': makeAgentStatusEntry({
        agentType: 'claude',
        paneKey: 'term-1:leaf-2',
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        providerSession: { key: 'session_id', id: 'claude-session-1' }
      })
    })
    const exited = makeAgentStatusEntry({
      agentType: 'claude',
      paneKey: 'term-1:leaf-1',
      tabId: 'term-1',
      worktreeId: WORKTREE_ID,
      providerSession: { key: 'session_id', id: 'claude-session-old' }
    })
    useAppStore.setState({
      terminalLayoutsByTabId: {
        'term-1': { root: null, activeLeafId: 'leaf-1', expandedLeafId: null }
      },
      retainedAgentsByPaneKey: {
        'term-1:leaf-1': {
          entry: exited,
          worktreeId: WORKTREE_ID,
          tab: makeTerminalTab('term-1', WORKTREE_ID, 'claude'),
          agentType: 'claude',
          startedAt: exited.stateStartedAt
        }
      }
    })
    expect(
      resolveTabSessionHistorySubject(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toEqual(cliSubject)
  })

  it.each(['grok', 'omp', 'opencode', 'opencode2', 'pi'] as const)(
    'finds a %s terminal tab, whose conversation a chat can take over',
    (agentType) => {
      const state = makeState({
        'term-1:leaf-1': makeAgentStatusEntry({
          agentType,
          paneKey: 'term-1:leaf-1',
          tabId: 'term-1',
          worktreeId: WORKTREE_ID,
          providerSession: { key: 'session_id', id: `${agentType}-session-1` }
        })
      })
      expect(
        resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toEqual({ ...cliSubject, agent: agentType, providerSessionId: `${agentType}-session-1` })
    }
  )

  it.each(['gemini'] as const)(
    'skips a %s terminal tab, whose conversation no chat can take over',
    (agentType) => {
      const state = makeState({
        'term-1:leaf-1': makeAgentStatusEntry({
          agentType,
          paneKey: 'term-1:leaf-1',
          tabId: 'term-1',
          worktreeId: WORKTREE_ID,
          providerSession: { key: 'session_id', id: `${agentType}-session-1` }
        })
      })
      expect(
        resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
    }
  )

  it('looks nothing up over SSH, where neither move is ever offered', () => {
    const state = makeState(liveClaudeEntry, { connectionId: 'dev-box' })
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'claude' }
      })
    ).toBeNull()
  })

  it('looks up both Chat and CLI conversations on their remote Orca server', () => {
    const state = makeState(liveClaudeEntry, {
      executionHostId: 'runtime:server-1'
    })
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'unified-1', worktreeId: WORKTREE_ID },
        nativeChat: { sessionId: 'orca-chat-1', agent: 'claude' }
      })
    ).toMatchObject({
      kind: 'chat',
      request: { executionHostScope: 'runtime:server-1' }
    })
    expect(
      resolveTabSessionHistorySubject(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toMatchObject({ kind: 'cli', request: { executionHostScope: 'runtime:server-1' } })
  })

  it('skips a plain shell tab', () => {
    expect(
      resolveTabSessionHistorySubject(makeState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID }
      })
    ).toBeNull()
  })
})

describe('one pane of a terminal tab', () => {
  const claudePane = 'term-1:leaf-1'
  const geminiPane = 'term-1:leaf-2'
  const splitTab = (activeLeafId: string): AppState => {
    makeState({
      [claudePane]: liveClaudeEntry['term-1:leaf-1'],
      [geminiPane]: makeAgentStatusEntry({
        agentType: 'gemini',
        paneKey: geminiPane,
        tabId: 'term-1',
        worktreeId: WORKTREE_ID,
        providerSession: { key: 'session_id', id: 'gemini-session-1' }
      })
    })
    useAppStore.setState({
      terminalLayoutsByTabId: { 'term-1': { root: null, activeLeafId, expandedLeafId: null } }
    })
    return useAppStore.getState()
  }
  const paneSubject = (state: AppState, paneKey: string) =>
    resolveTabSessionHistorySubject(state, {
      tab: { id: 'term-1', worktreeId: WORKTREE_ID },
      paneKey
    })
  const paneGate = (state: AppState, paneKey: string) =>
    canPaneOfferResumeInNewChat(state, { worktreeId: WORKTREE_ID, paneKey })

  it("never stands in a sibling pane's conversation for a pane with no move", () => {
    const state = splitTab('leaf-2')
    // The tab as a whole maps to the Claude pane; the Gemini pane on its own has nothing.
    expect(
      resolveTabSessionHistorySubject(state, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
    ).toEqual(cliSubject)
    expect(paneSubject(state, geminiPane)).toBeNull()
    expect(paneGate(state, geminiPane)).toBe(false)
  })

  it.each(['grok', 'omp', 'opencode', 'opencode2', 'pi'] as const)(
    "finds a %s pane's own conversation",
    (agentType) => {
      const paneKey = 'term-1:leaf-1'
      const state = makeState({
        [paneKey]: makeAgentStatusEntry({
          agentType,
          paneKey,
          tabId: 'term-1',
          worktreeId: WORKTREE_ID,
          providerSession: { key: 'session_id', id: `${agentType}-session-1` }
        })
      })
      expect(paneSubject(state, paneKey)).toEqual({
        ...cliSubject,
        agent: agentType,
        providerSessionId: `${agentType}-session-1`
      })
      expect(paneGate(state, paneKey)).toBe(true)
    }
  )

  it("finds the pane's own conversation", () => {
    const state = splitTab('leaf-1')
    expect(paneSubject(state, claudePane)).toEqual(cliSubject)
    expect(paneGate(state, claudePane)).toBe(true)
  })

  it.each(Object.keys(exitedAgentRecords))(
    'offers nothing once the agent exited and only a %s record remains, as the tab menu does',
    (kind) => {
      makeState()
      useAppStore.setState(exitedAgentRecords[kind])
      const exited = useAppStore.getState()
      expect(paneSubject(exited, claudePane)).toBeNull()
      expect(paneGate(exited, claudePane)).toBe(false)
      expect(
        resolveTabSessionHistorySubject(exited, { tab: { id: 'term-1', worktreeId: WORKTREE_ID } })
      ).toBeNull()
    }
  )

  it('offers nothing where the project runs in WSL, whose chat route is refused', () => {
    mocks.platform = 'win32'
    const onWindows = (
      localWindowsRuntimeDefault: { kind: 'wsl'; distro: string } | { kind: 'windows-host' }
    ) => {
      makeState(liveClaudeEntry)
      useAppStore.setState({
        settings: { ...getDefaultSettings('C:\\Users\\me'), localWindowsRuntimeDefault }
      })
      return useAppStore.getState()
    }
    expect(paneGate(onWindows({ kind: 'windows-host' }), claudePane)).toBe(true)
    expect(paneGate(onWindows({ kind: 'wsl', distro: 'Ubuntu' }), claudePane)).toBe(false)
  })

  it('offers nothing over SSH', () => {
    expect(paneGate(makeState(liveClaudeEntry, { connectionId: 'dev-box' }), claudePane)).toBe(
      false
    )
  })
  it('identifies a provider-only Continue source without a live turn or selecting its sibling', () => {
    makeState()
    const [L1, L2] = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222'
    ]
    const pane = `term-1:${L1}`
    const layout = (ptyIdsByLeafId: Record<string, string>) =>
      useAppStore.setState({
        terminalLayoutsByTabId: {
          'term-1': { root: null, activeLeafId: L1, expandedLeafId: null, ptyIdsByLeafId }
        }
      })
    layout({ [L1]: 'pty-1', [L2]: 'pty-2' })
    applyProviderSessionOnlyUpdate({
      store: useAppStore.getState(),
      batch: undefined,
      paneKey: pane,
      routing: { tabId: 'term-1', worktreeId: WORKTREE_ID },
      data: {
        paneKey: pane,
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: 1,
        state: 'done',
        prompt: '',
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'thread-c' },
        providerSessionOnly: true
      }
    })
    const state = useAppStore.getState()
    expect(state.agentStatusByPaneKey).toEqual({})
    expect(
      resolveCliChatResumeSource(state, {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toMatchObject({ agent: 'codex', providerSessionId: 'thread-c' })
    expect(paneGate(state, `term-1:${L2}`)).toBe(false)
    useAppStore
      .getState()
      .setAgentStatus(
        pane,
        { state: 'done', prompt: 'first', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'term-1', worktreeId: WORKTREE_ID },
        { providerSession: { key: 'session_id', id: 'thread-c' } }
      )
    useAppStore
      .getState()
      .setAgentStatus(pane, { state: 'working', prompt: 'second', agentType: 'codex' })
    expect(
      resolveCliChatResumeSource(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toBeNull()
    expect(paneGate(useAppStore.getState(), pane)).toBe(false)
    useAppStore
      .getState()
      .recordAgentProviderSession(
        pane,
        'codex',
        { key: 'session_id', id: 'thread-next' },
        undefined,
        { tabId: 'term-1', worktreeId: WORKTREE_ID }
      )
    expect(
      resolveCliChatResumeSource(useAppStore.getState(), {
        tab: { id: 'term-1', worktreeId: WORKTREE_ID },
        paneKey: pane
      })
    ).toMatchObject({ providerSessionId: 'thread-next' })
  })
})

describe('findTabSessionHistoryRow', () => {
  const chatRow = row({
    id: 'chat-row',
    structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
  })
  const cliRow = row({ id: 'cli-row' })

  it('matches a chat tab to the row its chat owns', () => {
    expect(findTabSessionHistoryRow([cliRow, chatRow], chatSubject)?.id).toBe('chat-row')
  })

  it('matches a terminal tab to the row of the same agent and conversation', () => {
    expect(findTabSessionHistoryRow([cliRow], cliSubject)?.id).toBe('cli-row')
    // A chat that resumed the conversation owns its row; the move's gate refuses it from there.
    const ownedRow = row({
      id: 'owned-row',
      structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
    })
    expect(findTabSessionHistoryRow([ownedRow], cliSubject)?.id).toBe('owned-row')
    expect(findTabSessionHistoryRow([row({ agent: 'codex' })], cliSubject)).toBeNull()
    // An OpenCode 2.x pane reports `opencode`; Session History lists its conversation as `opencode2`.
    const openCodeSubject = {
      ...cliSubject,
      agent: 'opencode' as const,
      providerSessionId: 'ses_1'
    }
    expect(
      findTabSessionHistoryRow(
        [row({ id: 'oc2-row', agent: 'opencode2', sessionId: 'ses_1' })],
        openCodeSubject
      )?.id
    ).toBe('oc2-row')
    expect(
      findTabSessionHistoryRow([row({ agent: 'grok', sessionId: 'ses_1' })], openCodeSubject)
    ).toBeNull()
    expect(
      findTabSessionHistoryRow(
        [
          row({
            subagent: { parentSessionId: 'p', agentType: null, status: null }
          })
        ],
        cliSubject
      )
    ).toBeNull()
  })
})

describe('resolveTabSessionSwitch', () => {
  const chatRow = row({
    structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID }
  })

  it('offers Switch to Terminal on a chat tab whose row can fork', () => {
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toEqual({
      action: 'resume-in-new-cli',
      worktreeId: WORKTREE_ID
    })
  })

  it('hides Switch to Terminal for an empty or unresumable chat', () => {
    expect(
      resolveTabSessionSwitch(
        makeState(),
        { ...chatRow, messageCount: 0, previewMessages: [] },
        chatSubject
      )
    ).toBeNull()
    mocks.resumeState = { blocked: true, worktreeId: null }
    expect(resolveTabSessionSwitch(makeState(), chatRow, chatSubject)).toBeNull()
  })

  it('offers Switch to Chat where the row is eligible, in the workspace it names', () => {
    mocks.resumeInChat.mockReturnValue({
      available: true,
      workspaceId: WORKTREE_ID
    })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toEqual({
      action: 'resume-in-new-chat',
      worktreeId: WORKTREE_ID
    })
    mocks.resumeInChat.mockReturnValue({ available: false, reason: 'empty' })
    expect(resolveTabSessionSwitch(makeState(), row(), cliSubject)).toBeNull()
  })
})

describe('lookupTabSessionHistoryRow', () => {
  const listResult = (sessions: AiVaultSession[], cancelled = false) => ({
    sessions,
    issues: [],
    scannedAt: 'now',
    ...(cancelled ? { cancelled: true as const } : {})
  })
  const emptyRow = row({ messageCount: 0, previewMessages: [] })
  const lookupOptions = { requestToken: 't', isCancelled: () => false }

  it("sends the panel's own request without writing the panel's cache", async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([row()]))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      id: 'row-1'
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith({
      includeAntigravityIdeSessions: true,
      limit: 250,
      unlimited: false,
      scopePaths: PANEL_REQUEST.scopePaths,
      executionHostScope: 'local',
      force: undefined,
      requestToken: 't'
    })
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)).toBeNull()
  })

  it("leaves the panel's cached list as it was, even after a forced rescan", async () => {
    cacheAiVaultSessionList(PANEL_REQUEST, listResult([row({ id: 'panel-row' })]), {
      replaceHostEntries: false
    })
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([emptyRow]))
    await lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)

    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)?.sessions.map((s) => s.id)).toEqual([
      'panel-row'
    ])
  })

  it('rescans once on a miss, from the shared forced-rescan budget', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(listResult([emptyRow]))
      .mockResolvedValueOnce(listResult([row()]))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      messageCount: 2
    })
    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
  })

  it('does not force another scan while the budget is spent', async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([emptyRow]))
    await lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    listSessions.mockClear()
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({
      messageCount: 0
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }))
  })

  it('starts no forced scan once the menu has closed, and leaves the budget free', async () => {
    let menuOpen = true
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => {
      menuOpen = false
      return listResult([emptyRow])
    })
    await lookupTabSessionHistoryRow(cliSubject, listSessions, {
      requestToken: 't',
      isCancelled: () => !menuOpen
    })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(claimAiVaultForcedRescan()).toBe(true)
  })

  it('forces no scan on a remote Orca server', async () => {
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([]))
    await lookupTabSessionHistoryRow(
      {
        ...chatSubject,
        request: { ...PANEL_REQUEST, executionHostScope: 'runtime:server-1' }
      },
      listSessions,
      lookupOptions
    )
    expect(listSessions).toHaveBeenCalledTimes(1)
  })

  it('finds a chat-owned row without spending a forced rescan', async () => {
    const owned = row({ structuredSession: { sessionId: 'orca-chat-1', workspaceId: WORKTREE_ID } })
    const listSessions = vi.fn(async (_args: AiVaultListArgs) => listResult([owned]))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toMatchObject({ structuredSession: { sessionId: 'orca-chat-1' } })
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(claimAiVaultForcedRescan()).toBe(true)
  })

  it('forces a rescan for a click even while the budget is spent, and takes the budget', async () => {
    expect(claimAiVaultForcedRescan()).toBe(true)
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(listResult([emptyRow]))
      .mockResolvedValueOnce(listResult([row()]))
    const clickOptions = { ...lookupOptions, userRequested: true }
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, clickOptions)
    ).resolves.toMatchObject({ messageCount: 2 })
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))
    resetAiVaultForcedRescanThrottleForTest()
    await lookupTabSessionHistoryRow(
      cliSubject,
      vi.fn().mockResolvedValue(listResult([])),
      clickOptions
    )
    expect(claimAiVaultForcedRescan()).toBe(false)
  })

  it('reports no answer when the lookup is cancelled', async () => {
    const listSessions = vi.fn().mockResolvedValue(listResult([], true))
    await expect(
      lookupTabSessionHistoryRow(cliSubject, listSessions, lookupOptions)
    ).resolves.toBeUndefined()
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(readCachedAiVaultSessionList(PANEL_REQUEST)).toBeNull()
  })
})
