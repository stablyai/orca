// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  created,
  createParams
} from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-create-message.test-fixture'
import type { AgentSessionModelCatalogResult } from '../../src/shared/agent-session/agent-session-wire'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type * as HostCapability from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { createNonSecureContextUuid as createBrowserUuid } from '../../src/shared/non-secure-context-uuid'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../src/main/runtime/orca-runtime'
import '../../src/main/runtime/rpc/methods/structured-sessions/creation/structured-agent-session-create'

import { setStructuredAgentSessionHost } from '../../src/main/native-chat/agent-session-wire/host/structured-agent-session-registry'
import '../../src/main/runtime/agent-session/installation/structured-agent-runtime-metadata'
import '../../src/main/claude/structured/launch/claude-structured-spawn-options'
import '../../src/main/codex/structured/threads/codex-structured-thread-open'
import '../../src/main/codex/structured/turns/codex-structured-message-options'
import '../../src/main/codex/structured/catalog/codex-structured-option-session.test-fixture'
import { startStructuredAgentLaunch } from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch'
import { getStructuredAgentSessionLaunchSelection } from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-options'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { recordHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/session/options/structured/use-structured-agent-session-options'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/host-access/use-native-chat-provisional-launch'
import { structuredAgentSessionMessageSelection } from '../../src/shared/agent-session/options/structured-agent-session-option-view'
import { structuredAgentSessionModelId } from '../../src/shared/agent-session/options/structured-agent-session-option-state'
import '../../src/shared/global-settings-test-fixture'
import '../../src/shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateFingerprint } from '../../src/shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  retryStructuredAgentSessionLaunchIntent,
  restoreStructuredAgentSessionLaunchIntent
} from '../../src/renderer/src/lib/launch-structured-agent-session'
import { getStructuredLaunchStateBySessionId } from '../../src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-registry'

vi.mock(
  '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability',
  async (original) => ({
    ...(await original<typeof HostCapability>()),
    useStructuredAgentSessionHostCapability: () => false,
    useStructuredAgentSessionOwnPermissionState: () => 'supported'
  })
)
vi.mock('@/components/native-chat/session/status/structured-agent-session-status-hooks', () => ({
  useStructuredAgentSessionPermissionStatus: () => ({
    permissionReport: false,
    observation: 'live'
  })
}))
vi.mock('../../src/main/agent-launch/trust/agent-workspace-trust', () => ({
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
