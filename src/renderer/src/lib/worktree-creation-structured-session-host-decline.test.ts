import type * as ProvisionalTab from './agent-session/structured-agent-session-provisional-tab'
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
    mainStarts,
    launches: vi.fn(),
    // Set by the cases whose chat main's frames draw.
    drawsFrames: false
  }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(async (_target: unknown, method: string) =>
    method === 'agentSession.createSupport' ? mocks.createSupport() : new Promise(() => undefined)
  ),
  structuredAgentSessionHostSupports: async () => mocks.hostAccepts
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
import { projectSourceControlActionLaunch } from '../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { tokenizeStartupCommand } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { submitFolderWorkspaceCreate } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'
import { worktreeHostLaunch } from './worktree-creation-host-launch'
import { buildAgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
import { compileAgentLaunchTerminalAlternative } from '../../../shared/agent-launch/startup/agent-launch-terminal-recipe'
import {
  CODEX_DRAFT_ONLY_TERMINAL_STARTUP,
  CODEX_PLANNED_DRAFT
} from '../../../shared/rpc-contract/agent-launch-accept-terminal-plan.test-fixture'
import { pendingCreationChatDraftScopeKey } from './pending-worktree-creation'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'

// A switch-on build's chat is drawn by main's frames, in the cases that draw them; the others keep
// the ordinary layout client.
vi.mock('@/runtime/runtime-layout-client', async (original) => {
  const actual = await original<Record<string, unknown>>()
  const framed: Record<string, unknown> = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(actual as never)
  return Object.fromEntries(
    Object.keys(framed).map((key) => [
      key,
      typeof framed[key] === 'function'
        ? (...args: unknown[]) =>
            ((mocks.drawsFrames ? framed : actual)[key] as (...args: unknown[]) => unknown)(...args)
        : framed[key]
    ])
  )
})

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
let drawn: TabsDrawnFromMain | undefined

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
    pendingWorktreeCreations: { 'creation-1': pendingCreation() },
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

function pendingCreation() {
  return {
    creationId: 'creation-1',
    phase: 'creating' as const,
    status: 'creating' as const,
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: REQUEST
  }
}

afterEach(() => {
  drawn?.close()
  drawn = undefined
  mocks.drawsFrames = false
  resetStructuredAgentLaunchRegistryForTests()
  mocks.hostAccepts = false
  mocks.hostLaunch.mockReset()
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
    pendingWorktreeCreations: { 'creation-1': pendingCreation() },
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

const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
const MESSAGE_ID = `${Date.now()}-000000000000000000000000000000ae`
const IDENTITY = {
  operationId: OPERATION_ID,
  sessionId: 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d',
  clientMessageId: MESSAGE_ID
}

/** What route selection left on the creation before its workspace was created. */
function choseHostLaunch(): void {
  useAppStore.getState().updatePendingWorktreeCreation('creation-1', { hostLaunch: IDENTITY })
}

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
    choseHostLaunch()
    mocks.drawsFrames = true
    drawn = await drawTabsFromMain(useAppStore)
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
    await drawn!.settle()
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
      prompt: { text: 'fix the flaky test', delivery: 'submit', clientMessageId: MESSAGE_ID },
      // No receipt came back from the create: uncertainty, never "nothing to wait for".
      setupReceipt: { required: true, runId: null },
      // The submit-time command already carries the quick prompt.
      terminalStartup: {
        kind: 'command',
        command: "claude --model opus 'fix the flaky test'",
        prompt: 'carried'
      }
    })

    // The host's terminal reaches this window, then the host says that is what it started.
    useAppStore.getState().createTab(LOCAL_CREATED.id, undefined, undefined, {
      id: TERMINAL_TAB
    })
    await drawn!.settle()
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
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
      }
    })

    await drawn!.settle()
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

describe('the terminal a host launch becomes, planned as this creation would open it', () => {
  function plan(args: {
    request: WorktreeCreationRequest
    prompt: string
    held?: string
    foreground: boolean
    worktreeId?: string
    agent?: 'codex'
  }) {
    return worktreeHostLaunch({
      creationId: 'creation-1',
      identity: IDENTITY,
      request: args.request,
      worktreeId: args.worktreeId ?? LOCAL_CREATED.id,
      agent: args.agent ?? 'claude',
      prompt: args.prompt,
      heldChatMessage: args.held,
      foreground: args.foreground
    }).accept!
  }

  it.each([
    ['its quick prompt', 'Fix the bug', undefined],
    ['a message held while it was created', 'Explain the failure', 'Explain the failure']
  ])(
    'in view, carries %s once, in the command the planner built for it',
    async (_case, prompt, held) => {
      seedThisMachine()
      const startupPlan = buildAgentStartupPlan({
        agent: 'claude',
        prompt: held ? '' : prompt,
        cmdOverrides: {},
        platform: 'darwin',
        allowEmptyPromptLaunch: true
      })
      const request = { ...REQUEST, quickPrompt: held ? '' : prompt, startupPlan }
      const accept = plan({ request, prompt, ...(held ? { held } : {}), foreground: true })
      expect(accept.terminalStartup).toMatchObject({ kind: 'command', prompt: 'carried' })
      expect(accept.launchSource).toBe('tab_bar_quick_launch')
      const startup = accept.terminalStartup
      expect(startup?.kind === 'command' && startup.command.split(prompt).length).toBe(2)
    }
  )

  it('out of view on this machine, with no startup plan, plans no terminal and starts none', async () => {
    seedThisMachine()
    const accept = plan({
      request: { ...REQUEST, startupPlan: null },
      prompt: 'fix the flaky test',
      foreground: false
    })
    expect(accept).not.toHaveProperty('terminalStartup')
  })

  it("out of view on a paired server, with no startup plan, starts the agent's own launcher and sends nothing", async () => {
    seedPairedServer()
    const accept = plan({
      request: { ...REQUEST, startupPlan: null },
      prompt: 'fix the flaky test',
      foreground: false,
      worktreeId: CREATED.id
    })
    expect(accept.terminalStartup).toEqual({ kind: 'agent', prompt: 'none' })
  })

  it('out of view on this machine, runs the submit-time command and leaves a held message unsent', async () => {
    seedThisMachine()
    const request = {
      ...REQUEST,
      quickPrompt: '',
      startupPlan: { launchCommand: 'claude --model opus', launchConfig: { agent: 'claude' } }
    } as unknown as WorktreeCreationRequest
    const accept = plan({ request, prompt: 'Explain it', held: 'Explain it', foreground: false })
    expect(accept.terminalStartup).toMatchObject({
      kind: 'command',
      command: 'claude --model opus',
      prompt: 'draft'
    })
  })

  /** A Codex workspace created from a linked issue, its context left unsent: the real composer plan. */
  function codexDraftOnlyRequest(): WorktreeCreationRequest {
    const { startupPlan, startupRecipe, telemetry } = buildQuickComposerStartup({
      agent: 'codex',
      prompt: '',
      draftPrompt: CODEX_PLANNED_DRAFT,
      settings: useAppStore.getState().settings,
      launchHost: { kind: 'known', platform: 'darwin', hostKind: 'local' },
      shell: 'posix',
      isRemote: false,
      telemetrySource: undefined
    })
    expect(startupPlan?.draftPrompt).toBe(CODEX_PLANNED_DRAFT)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the planner reads only these request fields.
    return {
      ...REQUEST,
      agent: 'codex',
      quickPrompt: '',
      promptDelivery: 'auto-submit',
      startupPlan,
      startupRecipe,
      quickTelemetry: telemetry
    } as unknown as WorktreeCreationRequest
  }

  it.each([
    ['out of view, from the creation planner of its submit', false],
    ['in view, from the new-tab planner', true]
  ])(
    'for a host that takes the first turn after Setup, sends the planner inputs %s, which plan the same terminal',
    async (_case, foreground) => {
      seedThisMachine()
      const request = codexDraftOnlyRequest()
      const args = {
        creationId: 'creation-1',
        request,
        worktreeId: LOCAL_CREATED.id,
        agent: 'codex' as const,
        prompt: 'Explain the failure',
        heldChatMessage: 'Explain the failure',
        foreground
      }
      const accepted = worktreeHostLaunch({ ...args, identity: IDENTITY }).accept!
      const prepared = worktreeHostLaunch({
        ...args,
        identity: { ...IDENTITY, protocol: 'release' }
      })
      expect(prepared.protocol).toBe('release')
      const alternative = prepared.accept!.terminalAlternative!
      expect(prepared.accept).not.toHaveProperty('terminalStartup')
      expect(alternative).toMatchObject({
        kind: 'planned',
        policy: foreground
          ? { kind: 'foreground', promptDelivery: 'auto-submit' }
          : { kind: 'background', draftPrompt: CODEX_PLANNED_DRAFT, heldChatMessage: true }
      })
      expect(prepared.accept!.launchSource).toBe(accepted.launchSource)
      // Settings changed after the handoff never reach the host's plan.
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, agentCmdOverrides: { codex: 'cx-later' } }
      }))
      const heldText = 'Explain the failure'
      // With the choices it was planned with, the host plans exactly the terminal accept carries.
      const unchanged = compileAgentLaunchTerminalAlternative({
        alternative,
        heldText,
        choices: {},
        replaceModelSelection: false
      })
      expect(unchanged).toEqual({ ok: true, startup: accepted.terminalStartup })
      // With a model and effort picked during Setup, its generated flags follow them.
      const changed = compileAgentLaunchTerminalAlternative({
        alternative,
        heldText,
        choices: { model: 'gpt-5.5', effort: 'high' },
        replaceModelSelection: true
      })
      const command =
        changed.ok && changed.startup?.kind === 'command' ? changed.startup.command : ''
      expect(command).toMatch(/^codex /)
      expect(command).toContain('gpt-5.5')
      expect(command).toContain('model_reasoning_effort=high')
    }
  )

  it.each([
    ['with no message held', undefined],
    ['beside a different message held while it was created', 'Explain the failure']
  ])(
    "out of view on this machine, sends the plan's own draft to paste unsent, %s",
    async (_case, held) => {
      seedThisMachine()
      const accept = plan({
        request: codexDraftOnlyRequest(),
        prompt: held ?? '',
        ...(held ? { held } : {}),
        foreground: false,
        agent: 'codex'
      })
      // The planned draft stays the draft; a held message is left unsent beside it.
      expect(accept.terminalStartup).toEqual(CODEX_DRAFT_ONLY_TERMINAL_STARTUP)
      expect(accept.prompt?.text).toBe(held)
      expect(accept.launchSource).toBe('new_workspace_composer')
    }
  )

  it('out of view on a paired server, sends no planned draft, as its after-wake terminal pastes none', async () => {
    seedPairedServer()
    const accept = plan({
      request: codexDraftOnlyRequest(),
      prompt: '',
      foreground: false,
      worktreeId: CREATED.id,
      agent: 'codex'
    })
    expect(accept.terminalStartup).toMatchObject({ kind: 'command', prompt: 'none' })
    expect(accept.terminalStartup).not.toHaveProperty('draftPrompt')
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
      const completion =
        kind === 'git'
          ? launchStructuredWorktreeSession({
              creationId: 'creation-1',
              request: { ...REQUEST, agent: 'codex', quickPrompt: '', launchInputs: projection },
              agentLaunchRoute: 'structured-native-chat',
              worktreeId: id,
              shouldActivateOnCompletion: true,
              activation: { primaryTabId: null },
              primaryTabId: null
            })
          : undefined
      // Main awaits the published tab, so release the held answer while admission is still pending.
      await (kind === 'folder'
        ? submitFolderWorkspaceCreate({
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
          })
        : vi.waitFor(() => expect(mocks.createSupport).toHaveBeenCalled()))

      expect(mocks.createSupport).toHaveBeenCalledOnce()
      projection.agentArgs = '--model later-form'
      projection.sessionOptions!.effort = 'low'
      if (projection.chatSessionOptions) {
        projection.chatSessionOptions.model = 'later-form'
      }
      answer.resolve({ supported: false })
      await completion
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
