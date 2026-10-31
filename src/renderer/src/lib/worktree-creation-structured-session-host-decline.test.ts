import type * as ProvisionalTab from './agent-session/structured-agent-session-provisional-tab'
// @vitest-environment happy-dom

import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const mocks = vi.hoisted(() => {
  const mainStarts: unknown[] = []
  return { createSupport: vi.fn(), mainStarts, launches: vi.fn() }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mocks.createSupport() : new Promise(() => undefined)
  )
}))

vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof ProvisionalTab>()
  return {
    ...actual,
    beginStructuredAgentSessionProvisionalLaunch: (
      ...args: Parameters<typeof actual.beginStructuredAgentSessionProvisionalLaunch>
    ) => {
      const result = actual.beginStructuredAgentSessionProvisionalLaunch(...args)
      mocks.launches(result)
      return result
    }
  }
})

import { useAppStore } from '@/store'
import { projectSourceControlActionLaunch } from '../../../shared/source-control-action-launch-preferences'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/folder-workspace-composer-submit'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

// Main's answer to the window's layout commands, as a switch-on build sends them, and the first
// terminals it starts for the window's new tabs.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) => {
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
  mocks.mainStarts.length = 0
  mocks.launches.mockClear()
  mocks.createSupport.mockReset()
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

  it('leaves a message sent before the worktree existed unsent in the agent terminal', async () => {
    mocks.createSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    seedThisMachine()
    useAppStore.setState({
      pendingWorktreeCreations: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only the held message and route.
        'creation-1': { heldChatMessage: 'add a test', phase: 'creating' } as never
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch reads only these request fields.
    const request = {
      ...REQUEST,
      agentLaunchRoute: 'structured-native-chat',
      quickPrompt: '',
      startupPlan: { launchCommand: 'claude', launchConfig: { agent: 'claude' } }
    } as unknown as WorktreeCreationRequest

    await launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: LOCAL_CREATED.id,
      shouldActivateOnCompletion: false,
      activation: false,
      primaryTabId: null
    })

    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[LOCAL_CREATED.id]).toHaveLength(1)
    )
    const tab = useAppStore.getState().tabsByWorktree[LOCAL_CREATED.id]![0]!
    expect(JSON.stringify(startupOf(tab.id))).toContain('add a test')
  })
})

describe.each(['git', 'folder'] as const)('foreground %s implicit Chat decline', (kind) => {
  it.each([`-c 'model="true"'`, '--add-dir docs', undefined, ''])(
    'delivers captured Args %s through actual fallback startup/config',
    async (agentArgs) => {
      seedThisMachine()
      useAppStore.setState(({ settings }) => ({
        settings: settings && {
          ...settings,
          agentDefaultSurface: 'chat',
          agentCmdOverrides: { codex: 'cx' },
          agentDefaultArgs: { codex: '--search' },
          agentPermissionDefault: 'own'
        }
      }))
      const projection: Omit<
        ReturnType<typeof projectSourceControlActionLaunch>,
        'sessionOptions' | 'chatSessionOptions'
      > & { sessionOptions?: Record<string, string>; chatSessionOptions?: Record<string, string> } =
        projectSourceControlActionLaunch(
          {
            agentId: 'codex',
            ...(agentArgs !== undefined ? { agentArgs } : {}),
            launchPreferences: {
              agentId: 'codex',
              modelSelection: {
                base: 'default',
                options: { effort: { agentId: 'codex', value: 'high' } }
              }
            }
          },
          'codex',
          { basePrompt: '' }
        )
      expect(projection.sessionOptions).toEqual({ effort: 'high' })
      expect(projection.chatSessionOptions).toEqual(
        agentArgs?.includes('model=') ? { model: 'true', effort: 'high' } : undefined
      )
      const answer = Promise.withResolvers<{ supported: boolean }>()
      mocks.createSupport.mockReturnValue(answer.promise)
      const id = kind === 'git' ? LOCAL_CREATED.id : folderWorkspaceKey('folder-workspace-1')
      await (kind === 'git'
        ? launchStructuredWorktreeSession({
            creationId: 'creation-1',
            request: { ...REQUEST, agent: 'codex', quickPrompt: '', launchInputs: projection },
            agentLaunchRoute: 'structured-native-chat',
            worktreeId: id,
            shouldActivateOnCompletion: true,
            activation: { primaryTabId: null },
            primaryTabId: null
          })
        : submitFolderWorkspaceCreate({
            projectGroup: makeProjectGroup(),
            name: 'created',
            lastAutoName: '',
            linkedWorkItem: null,
            note: '',
            quickAgent: 'codex',
            launchChoice: {
              agent: 'codex',
              route: 'structured-native-chat',
              executionHostId: 'local'
            },
            ...projection,
            autoRenameBranchFromWork: false,
            agentCmdOverrides: { codex: 'cx' },
            createFolderWorkspace: async () => {
              const workspace = makeFolderWorkspace()
              useAppStore.setState({ folderWorkspaces: [workspace] })
              return workspace
            },
            onOpenChange: vi.fn()
          }))

      expect(mocks.createSupport).toHaveBeenCalledOnce()
      projection.agentArgs = '--model later-form'
      projection.sessionOptions!.effort = 'low'
      if (projection.chatSessionOptions) {
        projection.chatSessionOptions.model = 'later-form'
      }
      answer.resolve({ supported: false })
      await vi.waitFor(() => expect(useAppStore.getState().tabsByWorktree[id]).toHaveLength(1))
      const tab = useAppStore.getState().tabsByWorktree[id]![0]!
      const actualArgs = agentArgs ?? '--search'
      const expectedTokens = agentArgs?.includes('model=')
        ? ['-c', 'model="true"']
        : actualArgs === ''
          ? []
          : actualArgs.split(' ')
      const startup = startupOf(tab.id)
      const baseCommand = ['cx', ...expectedTokens.map((token) => `'${token}'`)].join(' ')
      expect(startup).toEqual({
        command: `${baseCommand} '-c' 'model_reasoning_effort=high'`,
        env: {},
        launchConfig: { agentCommand: baseCommand, agentArgs: actualArgs, agentEnv: {} },
        launchAgent: 'codex',
        ...(agentArgs !== undefined ? { agentArgsOverride: agentArgs } : {}),
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'tab_bar_quick_launch',
          request_kind: 'new'
        },
        launchToken: expect.any(String)
      })
      expect(Object.hasOwn(startup!, 'agentArgsOverride')).toBe(agentArgs !== undefined)
      expect(
        tokenizeStartupCommand(
          String(
            startup && typeof startup === 'object' && 'command' in startup ? startup.command : ''
          ),
          'posix'
        )
      ).toMatchObject({
        ok: true,
        tokens: ['cx', ...expectedTokens, '-c', 'model_reasoning_effort=high']
      })
      await expect(mocks.launches.mock.calls.at(-1)![0].settlement).resolves.toEqual({
        kind: 'terminal'
      })
      expect(mocks.launches).toHaveBeenCalledOnce()
      expect(mocks.createSupport).toHaveBeenCalledOnce()
      expect(JSON.stringify(startup)).not.toMatch(/chatSessionOptions|chatLaunchOptions|later-form/)
      expect(
        (useAppStore.getState().unifiedTabsByWorktree[id] ?? []).filter(
          (candidate) => candidate.contentType === 'agent-session'
        )
      ).toEqual([])
    }
  )
})
