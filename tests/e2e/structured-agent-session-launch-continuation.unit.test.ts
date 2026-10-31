// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  created,
  createParams
} from '../../src/renderer/src/lib/structured-agent-session-launch-create-message.test-fixture'
import type { AgentSessionModelCatalogResult } from '../../src/shared/agent-session-wire'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { mkdir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from '../../src/main/runtime/rpc/methods/structured-agent-session-create'
import type { StructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentRuntimeMetadata } from '../../src/main/runtime/structured-agent-runtime-metadata'
import { claudeStructuredSpawnOptions } from '../../src/main/claude/claude-structured-spawn-options'
import { openCodexThread } from '../../src/main/codex/codex-structured-thread-open'
import { resolvedCodexMessageOptions } from '../../src/main/codex/codex-structured-message-options'
import { optionSession } from '../../src/main/codex/codex-structured-option-session.test-fixture'
import { startStructuredAgentLaunch } from '../../src/renderer/src/lib/structured-agent-session-launch'
import { getStructuredAgentSessionLaunchSelection } from '../../src/renderer/src/lib/structured-agent-session-launch-options'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import { structuredAgentSessionMessageSelection } from '../../src/shared/structured-agent-session-option-view'
import { structuredAgentSessionModelId } from '../../src/shared/structured-agent-session-option-state'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import { CreateIntentParams } from '../../src/shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateFingerprint } from '../../src/shared/structured-agent-session-mutation'
import {
  retryStructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent
} from '../../src/renderer/src/lib/launch-structured-agent-session'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-registry'

vi.mock('@/runtime/structured-agent-session-host-capability', async (original) => ({
  ...(await original<typeof HostCapability>()),
  useStructuredAgentSessionHostCapability: () => false,
  useStructuredAgentSessionOwnPermissionState: () => 'supported'
}))
vi.mock('@/components/native-chat/StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionStatusSummary: () => ({ summary: null, observation: 'live' })
}))
vi.mock('../../src/main/agent-workspace-trust', () => ({
  applyAgentWorkspaceTrust: vi.fn(async () => ({}))
}))
let restore: (() => void) | undefined
let root: string
beforeEach(async () => {
  restore = resetCreateMessageFixture()
  mocks.exactSupport.mockResolvedValue(true)
  root = await mkdtemp(join(await realpath(tmpdir()), 'orca-36210-continuation-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'profile'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  setStructuredAgentSessionHost(null)
  cleanupCreateMessageFixture(restore)
  for (const key of Object.keys(mocks.settings)) {
    delete mocks.settings[key]
  }
  await rm(root, { recursive: true, force: true })
})

it.each(['claude', 'codex'] as const)(
  'carries renderer lifetime through host intent to the real %s provider builders',
  async (agent) => {
    const home = join(root, 'account')
    const providerSessionId = '0198c2a4-7d1e-7c3a-9a4b-1f2e3d4c5b6a'
    const transcript = join(
      home,
      agent === 'claude' ? 'projects/workspace' : 'sessions',
      `${providerSessionId}.jsonl`
    )
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, '{}\n')
    const settings = createGlobalSettingsFixture({
      agentPermissionDefault: 'own',
      nativeChatInheritShellEnvironment: false,
      agentDefaultEnv: {
        [agent]: { [agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home }
      },
      agentLaunchChoices: {
        [agent]: {
          model: 'authored-new',
          options: {
            effort: 'low',
            ...(agent === 'claude' ? { fastMode: 'false' } : { serviceTier: 'default' })
          }
        }
      }
    })
    Object.assign(mocks.settings, settings)
    const store = { getSettings: () => settings }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create-intent resolution only reads this runtime store's settings.
    const runtime = new OrcaRuntimeService(store as never, undefined, {
      prepareCodexStructuredLaunch: () => home
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'assertStructuredAdoptionTerminalWritersExited').mockResolvedValue()
    Object.assign(runtime, {
      resolveStructuredAgentSessionLocation: async () => ({
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      }),
      resolveRuntimeFileTarget: async () => ({ worktree: { path: root } })
    })
    const minimalHost = {
      deps: {
        store: {
          getOperationRow: () => undefined,
          getRecord: () => undefined,
          listOperationRows: () => [],
          listConversations: () => []
        },
        agents: {
          definition: (id: string) => structuredAgentRuntimeMetadata(id)?.definition ?? null
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this preparation-only host exposes exactly the record/definition readers; no provider/host method is invoked.
    const host = minimalHost as unknown as StructuredAgentSessionHost
    for (const paired of [false, true]) {
      for (const fastMode of agent === 'claude' ? [true, false] : [false]) {
        for (const scenario of ['fresh', 'continuing', 'picked'] as const) {
          resetStructuredAgentLaunchRegistryForTests()
          const continuing = scenario !== 'fresh'
          const explicit =
            scenario === 'picked'
              ? {
                  model: 'genuine-pick',
                  effort: 'high',
                  ...(agent === 'claude'
                    ? { fastMode: String(fastMode) }
                    : { serviceTier: 'default' })
                }
              : undefined
          const remembered = {
            model: 'remembered',
            valuesByModel: {
              remembered: {
                effort: 'high',
                ...(agent === 'claude' ? { fastMode } : { serviceTier: 'default' })
              }
            }
          }
          settings.nativeChatSessionOptions = { [agent]: remembered }
          Object.assign(mocks.settings, settings)
          const target = paired
            ? { kind: 'environment' as const, environmentId: 'alpha' }
            : { kind: 'local' as const }
          recordHostModelCatalogSnapshot(target, agent, null, {
            origin: 'probe',
            fetchedAt: 1,
            defaultHoldsInEveryWorkspace: true,
            models: [
              {
                id: 'authored-new',
                label: 'Authored',
                isDefault: true,
                efforts: [{ value: 'low', label: 'Low' }]
              },
              {
                id: 'remembered',
                label: 'Remembered',
                isDefault: false,
                efforts: [{ value: 'high', label: 'High' }]
              }
            ]
          })
          mocks.admit.mockResolvedValue({
            kind: 'admitted',
            seedOptions: {
              model: 'authored-new',
              effort: 'low',
              ...(agent === 'claude' ? { fastMode: 'false' } : { serviceTier: 'default' })
            }
          })
          let prepared:
            | Awaited<ReturnType<typeof prepareStructuredAgentSessionCreateForWorktree>>
            | undefined
          mocks.call.mockImplementation(async (_target, method, input) => {
            if (method !== 'agentSession.create') {
              throw new Error(`unexpected ${method}`)
            }
            const params = CreateIntentParams.parse(input)
            prepared = await prepareStructuredAgentSessionCreateForWorktree({
              runtime,
              ensureHost: async () => host,
              caller: { callerKey: 'renderer' },
              ...params,
              atRest: true
            })
            return created()
          })
          mocks.call.mockClear()
          const launch = startStructuredAgentLaunch('workspace-1', agent, {
            requestId: createBrowserUuid(),
            executionHostId: paired ? 'runtime:alpha' : 'local',
            prompt: 'continue normally',
            ...(continuing ? { resumeFrom: { providerSessionId } } : {}),
            ...(explicit ? { launchOptions: explicit } : {})
          })
          await launch.launchResult
          expect(prepared).toBeDefined()
          const params = createParams()
          const options = prepared?.attachParams.options
          const expectedModel = explicit
            ? 'genuine-pick'
            : continuing
              ? 'remembered'
              : 'authored-new'
          expect(options).toMatchObject({
            model: expectedModel,
            effort: continuing ? 'high' : 'low',
            ...(agent === 'claude'
              ? { fastMode: continuing ? String(fastMode) : 'false' }
              : { serviceTier: 'default' })
          })
          expect(prepared?.attachParams.accountHome).toEqual({
            variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
            path: home
          })
          if (continuing) {
            if (explicit) {
              expect(params.options).toMatchObject(explicit)
            } else {
              expect(params.options).toBeUndefined()
            }
            expect(params.firstMessage?.selection).toEqual(explicit ?? {})
            expect(prepared?.attachParams.adopt).toMatchObject({
              transcriptPath: transcript,
              source: { providerSessionId, workspaceCwd: root }
            })
          } else {
            expect(params.firstMessage?.selection?.model).toBe('authored-new')
          }
          if (agent === 'claude') {
            const spawn = claudeStructuredSpawnOptions({
              launch: {
                options: {
                  resume: continuing ? providerSessionId : undefined,
                  extraArgs: { model: 'raw-pin', settings: '{"theme":"light"}', 'add-dir': 'docs' }
                },
                resumesTranscript: continuing
              },
              saved: options,
              effortFlag: 'supported',
              flagSettingsControl: 'supported'
            })
            expect(spawn.sdkOptions.model).toBe(expectedModel)
            expect(spawn.sdkOptions.extraArgs).toEqual({
              settings: '{"theme":"light"}',
              'add-dir': 'docs'
            })
            expect(spawn.options.get('fastMode')).toBe(continuing ? String(fastMode) : 'false')
            expect(spawn.fastModeAtStart).toBe(true)
          } else {
            const request = vi.fn<
              (
                method: string,
                params?: Record<string, unknown>,
                options?: { timeoutMs?: number | null }
              ) => Promise<unknown>
            >(async () => ({
              thread: { id: providerSessionId },
              model: 'gpt-live',
              reasoningEffort: 'high'
            }))
            await openCodexThread(
              { request },
              {
                cwd: root,
                resumeThreadId: continuing ? providerSessionId : null,
                model: options?.model,
                commandEnv: { ORIGINAL: 'retained' }
              },
              null
            )
            expect(request.mock.calls[0]?.[0]).toBe(continuing ? 'thread/resume' : 'thread/start')
            expect(request.mock.calls[0]?.[1]).toMatchObject({
              cwd: root,
              config: { 'shell_environment_policy.set.ORIGINAL': 'retained' }
            })
            if (continuing) {
              expect(request.mock.calls[0]?.[1]).not.toHaveProperty('model')
            }
            const turn = await resolvedCodexMessageOptions(
              optionSession(request),
              params.firstMessage?.selection
            )
            if (explicit) {
              expect(turn?.model).toBe('genuine-pick')
            } else if (continuing) {
              expect(turn).not.toHaveProperty('model')
            } else {
              expect(turn?.model).toBe('authored-new')
            }
          }
        }
      }
    }
  }
)

it('admits paired continuation picks after support, keeps unknown display unsent, and freezes prepared replay', async () => {
  const admission = Promise.withResolvers<Awaited<ReturnType<typeof mocks.admit>>>()
  const capability = Promise.withResolvers<boolean>()
  const create = Promise.withResolvers<unknown>()
  const hydration = Promise.withResolvers<unknown>()
  const target = { kind: 'environment', environmentId: 'alpha' } as const
  const catalog: AgentSessionModelCatalogResult = {
    origin: 'probe',
    fetchedAt: 1,
    defaultHoldsInEveryWorkspace: true,
    models: [
      {
        id: 'fresh-map',
        label: 'Fresh map',
        isDefault: true,
        efforts: [{ value: 'low', label: 'Low' }]
      },
      {
        id: 'literal-held',
        label: 'Held choice',
        isDefault: false,
        efforts: [{ value: 'high', label: 'High' }]
      }
    ]
  }
  replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 1 }])
  recordHostModelCatalogSnapshot(target, 'claude', null, catalog)
  mocks.admit.mockReturnValue(admission.promise)
  mocks.exactSupport.mockReturnValue(capability.promise)
  mocks.call.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.modelCatalog') {
      return catalog
    }
    if (method === 'agentSession.options') {
      return hydration.promise
    }
    if (method === 'agentSession.create') {
      return create.promise
    }
    throw new Error(`unexpected ${method}`)
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
    requestId: createBrowserUuid(),
    executionHostId: 'runtime:alpha',
    resumeFrom: { providerSessionId: 'existing' },
    prompt: 'next'
  })
  const view = renderHook(
    ({ attached }) => {
      const provisional = useNativeChatProvisionalLaunch('workspace-1', launch.sessionId)
      return useStructuredAgentSessionOptions({
        agent: 'claude',
        sessionId: launch.sessionId,
        target,
        launch: provisional.launch,
        transportEnabled: attached,
        isVisible: true,
        providerVisible: attached,
        fence: attached ? 1 : null,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate: vi.fn()
      })
    },
    { initialProps: { attached: false } }
  )
  expect(getStructuredAgentSessionLaunchSelection(launch.sessionId)?.seedPending).toBe(true)
  expect(view.result.current.optionSnapshot.find((row) => row.id === 'model')?.settable).toBe(false)
  await act(async () =>
    admission.resolve({ kind: 'admitted', seedOptions: { model: 'fresh-map', effort: 'low' } })
  )
  await vi.waitFor(() =>
    expect(getStructuredAgentSessionLaunchSelection(launch.sessionId)?.seedPending).toBeUndefined()
  )
  const selection = getStructuredAgentSessionLaunchSelection(launch.sessionId)
  expect(selection?.seed).toBeUndefined()
  const provisional = view.result.current.sendSource.optionView(
    view.result.current.sendSource.optionStateRef.current,
    selection?.seed
  )
  expect(structuredAgentSessionModelId(provisional.record, 'own')).toBeNull()
  expect(structuredAgentSessionMessageSelection(provisional)).toEqual({})
  await act(async () => {
    expect(await view.result.current.setStructuredOption('model', 'literal-held')).toBe(true)
  })
  await act(async () => {
    expect(await view.result.current.setStructuredOption('effort', 'high')).toBe(true)
    expect(await view.result.current.setStructuredOption('fastMode', false)).toBe(true)
  })
  capability.resolve(true)
  await vi.waitFor(() =>
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(1)
  )
  const params = createParams()
  expect(params.options).toEqual({ model: 'literal-held', effort: 'high', fastMode: 'false' })
  expect(params.firstMessage?.selection).toEqual(params.options)
  expect(params.envelope.payloadFingerprint).toBe(
    structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
  )
  const state = getStructuredLaunchStateBySessionId(launch.sessionId)
  if (!state) {
    throw new Error('missing continuing launch')
  }
  Object.assign(mocks.settings, { agentLaunchChoices: { claude: { model: 'later' } } })
  const restored = restoreStructuredAgentSessionLaunchIntent({
    worktreeId: 'workspace-1',
    executionHostId: 'runtime:alpha',
    sessionId: launch.sessionId,
    clientOperationId: params.envelope.clientOperationId,
    payloadFingerprint: params.envelope.payloadFingerprint,
    expectedRuntimeFence: params.envelope.expectedRuntimeFence,
    agent: 'claude',
    resumeFrom: params.resumeFrom,
    options: params.options,
    firstMessage: params.firstMessage,
    createMessageSupport: true
  })
  expect(restored.params).toEqual(params)
  expect(restored.seedOptions).toBeUndefined()
  expect(retryStructuredAgentSessionLaunchIntent(state.intent).seedOptions).toBeUndefined()
  expect(
    restoreStructuredAgentSessionLaunchIntent({
      worktreeId: 'workspace-1',
      executionHostId: 'local',
      sessionId: launch.sessionId,
      agent: 'claude',
      clientOperationId: 'new',
      payloadFingerprint: '',
      expectedRuntimeFence: null,
      resumeFrom: params.resumeFrom
    }).seedOptions?.model
  ).not.toBe('later')
  await act(async () => {
    create.resolve(created())
    await launch.launchResult
  })
  view.rerender({ attached: true })
  await act(async () =>
    hydration.resolve({
      models: catalog.models,
      current: {
        model: 'literal-held',
        effort: 'high',
        fastMode: false,
        permissionMode: 'own',
        defaulted: []
      }
    })
  )
  await vi.waitFor(() =>
    expect(view.result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
  )
  const hydrated = view.result.current.optionSnapshot.find((row) => row.id === 'model')
  expect(hydrated).toMatchObject({ settable: true, kind: { currentValue: 'literal-held' } })
  view.unmount()
})
