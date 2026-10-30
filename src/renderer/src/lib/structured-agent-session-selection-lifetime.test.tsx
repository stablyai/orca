import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from '@/components/native-chat/use-structured-agent-session-mutate'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { useStructuredAgentSessionOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import { structuredAgentSessionSeedCatalog } from '../../../shared/structured-agent-session-seed-catalog'
import { structuredAgentSessionMessageSelection } from '../../../shared/structured-agent-session-option-view'
import { structuredAgentSessionModelId } from '../../../shared/structured-agent-session-option-state'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import {
  holdStructuredAgentSessionLaunchOption,
  structuredLaunchSelectionController
} from './structured-agent-session-launch-options'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import { listRuntimeSessionHostsForStartup } from '@/app-shell/startup-runtime-session-hosts'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  registerStructuredSelectionCatalogStore,
  forgetStructuredSessionSelection,
  structuredSessionSelectionController
} from './structured-agent-session-selection-controller'

const unavailableMutation: StructuredAgentSessionMutate = async () => null

const transport = vi.hoisted(() => ({
  create: vi.fn(),
  intent: vi.fn(),
  call: vi.fn(),
  remember: vi.fn()
}))
vi.mock('./launch-structured-agent-session', () => ({
  createStructuredAgentSessionLaunchIntent: transport.intent,
  abandonStructuredAgentSessionLaunchIntent: vi.fn()
}))
vi.mock('./structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: transport.create
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: transport.call
}))
vi.mock('@/components/native-chat/StructuredAgentSessionStatusBridge', () => ({
  useStructuredAgentSessionStatusSummary: () => ({ summary: undefined, observation: 0 })
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapability: () => true,
  useStructuredAgentSessionOwnPermissionState: () => 'supported',
  structuredAgentSessionHostKey: () => 'paired-host'
}))
vi.mock('@/components/native-chat/native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: transport.remember
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }))

const target = { kind: 'environment', environmentId: 'paired-host' } as const
const sessionId = 'codex_reconnect'
const initial = useAppStore.getState()
const catalog = structuredAgentSessionSeedCatalog('codex')
const seed = { model: 'gpt-5.5' }
function publish(runtimeId: string, sequence: number) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production status slice reads runtime identity and protocol fields here.
  const status = {
    runtimeId,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3
  } as RuntimeStatus
  useAppStore.getState().setRuntimeEnvironmentStatus(
    target.environmentId,
    {
      status,
      checkedAt: sequence,
      snapshot: {
        environmentId: target.environmentId,
        pairingRevision: 1,
        sequence,
        checkedAt: sequence,
        status,
        verification: 'verified',
        transport: 'ready'
      }
    },
    { suppressDisconnectToast: true }
  )
}
afterEach(() => {
  cleanup()
  forgetStructuredSessionSelection(sessionId)
  resetStructuredAgentLaunchRegistryForTests()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
})

it.each([false, true])(
  'keeps launch, hook, drawn and captured operations through the real runtime transition (newer pick=%s)',
  async (newer) => {
    const intent: StructuredAgentSessionLaunchIntent = {
      worktreeId: 'wt-lifetime',
      executionHostId: 'runtime:paired-host',
      target,
      sessionId,
      agent: 'codex',
      seedOptions: seed,
      params: {
        agent: 'codex',
        worktree: 'id:wt-lifetime',
        envelope: {
          sessionId,
          clientOperationId: 'original-create',
          payloadFingerprint: 'frozen',
          expectedRuntimeFence: null
        }
      }
    }
    transport.intent.mockReturnValue(intent)
    const create = Promise.withResolvers<{ sessionId: string; fence: number }>()
    transport.create.mockReturnValue(create.promise)
    const replies = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
    const reads: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
    let sends = 0
    transport.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.options') {
        const read = Promise.withResolvers<unknown>()
        reads.push(read)
        return read.promise
      }
      if (method === 'agentSession.setOption') {
        return replies[sends++].promise
      }
      return Promise.resolve({})
    })
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    publish('runtime-A', 1)
    const launch = startStructuredAgentLaunch('wt-lifetime', 'codex', {
      requestId: 'lifetime',
      executionHostId: 'runtime:paired-host'
    })
    const state = getStructuredLaunchStateBySessionId(sessionId)!
    const owner = structuredLaunchSelectionController(state)
    let original: ReturnType<typeof holdStructuredAgentSessionLaunchOption>
    act(() => {
      original = holdStructuredAgentSessionLaunchOption(sessionId, 'model', 'gpt-5.4')
    })
    const hook = renderHook(
      ({ visible }) =>
        useStructuredAgentSessionOptions({
          agent: 'codex',
          sessionId,
          target,
          fence: visible ? 7 : null,
          launch: { kind: 'new', seedOptions: seed },
          isVisible: false,
          transportEnabled: true,
          providerVisible: visible,
          turnId: null,
          unloadedTurnRevisions: undefined,
          mutate: unavailableMutation
        }),
      { initialProps: { visible: false } }
    )
    const readHook = renderHook(() =>
      useStructuredAgentSessionOptionState({
        agent: 'codex',
        optionCatalog: catalog,
        identity: `codex:${sessionId}`,
        fence: 1,
        sessionId,
        target,
        newLaunch: true,
        seedsModel: true,
        providerVisible: true,
        providerStarting: false,
        hostOptionStamp: '',
        readsBeforeStart: true,
        turnId: null,
        unloadedTurnRevisions: undefined
      })
    )
    expect(reads).toHaveLength(1)
    const capture = () => {
      const source = hook.result.current.sendSource
      const view = source.optionView(source.optionStateRef.current, seed)
      return {
        drawn: structuredAgentSessionModelId(view.record, 'own'),
        selection: structuredAgentSessionMessageSelection(view)
      }
    }
    let settled = false
    void original!.then(() => {
      settled = true
    })
    const retainedOwners = new Set([owner])
    for (let generation = 2; generation <= (newer ? 100 : 10); generation++) {
      act(() => publish(`runtime-${generation}`, generation))
      retainedOwners.add(structuredSessionSelectionController(target, sessionId, 'codex'))
      retainedOwners.add(structuredLaunchSelectionController(state))
    }
    expect(retainedOwners.size).toBe(1)
    await act(async () => reads[0].resolve({ models: [], current: { model: 'stale-generation' } }))
    expect(readHook.result.current.optionState.optionsAnswerPresent).not.toBe(true)
    readHook.unmount()
    reads.length = 0
    expect(structuredSessionSelectionController(target, sessionId, 'codex')).toBe(owner)
    expect(structuredLaunchSelectionController(state)).toBe(owner)
    expect(settled).toBe(false)
    expect(capture()).toMatchObject({ drawn: 'gpt-5.4', selection: { model: 'gpt-5.4' } })
    let chosen = original!
    if (newer) {
      act(() => {
        chosen = holdStructuredAgentSessionLaunchOption(sessionId, 'model', 'gpt-5.3-codex')!
      })
      await expect(original!).resolves.toEqual({ kind: 'superseded' })
    }
    const model = newer ? 'gpt-5.3-codex' : 'gpt-5.4'
    expect(capture()).toMatchObject({ drawn: model, selection: { model } })
    await act(async () => create.resolve({ sessionId, fence: 7 }))
    expect(sends).toBe(1)
    hook.rerender({ visible: true })
    await waitFor(() => expect(reads).toHaveLength(1))
    let attached: Promise<boolean> | undefined
    if (newer) {
      act(() => {
        attached = hook.result.current.setStructuredOption('effort', 'high')
      })
      expect(sends).toBe(2)
      expect(capture().selection).toMatchObject({ model, effort: 'high' })
      await act(async () =>
        replies[1].resolve({ ok: true, value: { options: { model, effort: 'high' } } })
      )
      await expect(attached).resolves.toBe(true)
      expect(transport.remember.mock.calls[0][1]).toMatchObject({
        picks: [{ modelId: model, optionId: 'effort', value: 'high' }]
      })
    }
    // This query predates acceptance and cannot acknowledge its later terminal identity.
    await act(async () => replies[0].resolve({ ok: true, value: { options: { model } } }))
    await expect(chosen).resolves.toMatchObject({ kind: 'accepted' })
    await launch.launchResult
    const completed = owner.captureRead()
    expect(completed).toHaveLength(newer ? 2 : 1)
    expect(transport.remember).toHaveBeenCalledTimes(newer ? 2 : 1)
    if (newer) {
      expect(transport.remember.mock.calls[1][1]).toMatchObject({
        picks: [
          { modelId: model, optionId: 'model', value: model, adoptModelAsLaunchDefault: false }
        ]
      })
    }
    expect(hook.result.current.sendSource.optionStateRef.current.optionsAnswerPresent).not.toBe(
      true
    )
    await act(async () => reads[0].resolve({ models: [], current: { model: 'other-client' } }))
    await waitFor(() => expect(reads).toHaveLength(2))
    expect(owner.captureRead()).toEqual(completed)
    await act(async () => reads[1].resolve({ models: [], current: { model: 'other-client' } }))
    await waitFor(() => expect(owner.captureRead()).toEqual([]))
    expect(owner.overlay()).toEqual({})
    expect(capture().drawn).toBe('other-client')
  }
)

const environment = (revision: number): PublicKnownRuntimeEnvironment => ({
  id: target.environmentId,
  name: 'restored',
  createdAt: 1,
  updatedAt: revision,
  pairingRevision: revision,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'loopback'
})

it.each(['present', 'initially-absent', 'already-hydrated'] as const)(
  'initializes restored hook affinity only at the first authoritative publication (%s)',
  async (mode) => {
    useAppStore.getState().setRuntimeEnvironments([])
    useAppStore.setState({
      runtimeEnvironmentCatalogHydrated: mode === 'already-hydrated',
      runtimeEnvironmentCatalogSettled: false
    })
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('first list failed'))
      .mockResolvedValue([environment(1)])
    const previousApi = window.api
    Object.defineProperty(window, 'api', {
      value: { runtimeEnvironments: { list } },
      configurable: true,
      writable: true
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      if (mode !== 'already-hydrated') {
        await useAppStore.getState().hydrateRuntimeEnvironmentStatuses()
        expect(useAppStore.getState().runtimeEnvironmentCatalogHydrated).toBe(false)
        expect(useAppStore.getState().runtimeEnvironmentCatalogSettled).toBe(true)
        expect((await listRuntimeSessionHostsForStartup()).hostIds).toEqual(['runtime:paired-host'])
      }
      const restored = structuredAgentSessionTargetForTab(useAppStore.getState(), {
        worktreeId: 'restored',
        executionHostId: 'runtime:paired-host'
      })!
      transport.call.mockResolvedValue({ models: [], current: { model: 'gpt-5.5' } })
      const hook = renderHook(
        ({ visible }) =>
          useStructuredAgentSessionOptionState({
            agent: 'codex',
            optionCatalog: catalog,
            identity: `codex:${sessionId}`,
            fence: 7,
            sessionId,
            target: restored,
            newLaunch: false,
            seedsModel: false,
            providerVisible: visible,
            providerStarting: false,
            hostOptionStamp: '',
            readsBeforeStart: false,
            turnId: null,
            unloadedTurnRevisions: undefined
          }),
        { initialProps: { visible: false } }
      )
      const owner = hook.result.current.controller
      const held = owner.issue('model', 'gpt-5.4', null)
      const unqualified = vi.fn()
      await expect(owner.request(unqualified)).rejects.toThrow('unavailable')
      expect(unqualified).not.toHaveBeenCalled()
      act(() =>
        useAppStore.getState().setRuntimeEnvironments(mode === 'present' ? [environment(1)] : [])
      )
      expect(hook.result.current.controller).toBe(owner)
      if (mode === 'present') {
        hook.rerender({ visible: true })
        await waitFor(() =>
          expect(transport.call).toHaveBeenCalledWith(
            restored,
            'agentSession.options',
            expect.anything(),
            { expectedEnvironmentPairingRevision: 1 }
          )
        )
        expect(held.outcome).toBeUndefined()
        act(() => useAppStore.getState().setRuntimeEnvironments([environment(2)]))
        expect(held.outcome).toEqual({ kind: 'superseded' })
        await expect(owner.request(async () => 'unsafe')).rejects.toThrow('retired')
      } else {
        act(() => useAppStore.getState().setRuntimeEnvironments([environment(2)]))
        const send = vi.fn()
        await expect(owner.request(send)).rejects.toThrow('unavailable')
        expect(send).not.toHaveBeenCalled()
      }
    } finally {
      error.mockRestore()
      Object.defineProperty(window, 'api', {
        value: previousApi,
        configurable: true,
        writable: true
      })
    }
  }
)

it.each([false, true])(
  'retains the answered desktop descriptor and capture across contact, not true end (pending=%s)',
  async (pending) => {
    resetHostModelCatalogSnapshotsForTests()
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    publish('answered-runtime-1', 1)
    const answer: AgentSessionOptionsResult = {
      models: ['gpt-5.5', 'gpt-5.4'].map((id) => ({
        id,
        label: id,
        isDefault: false,
        efforts: []
      })),
      current: {
        model: 'gpt-5.5',
        permissionMode: 'own',
        reportedPermissionMode: 'full-access',
        acceptedInputSources: { model: 'saved' }
      }
    }
    const reads: ReturnType<typeof Promise.withResolvers<AgentSessionOptionsResult>>[] = []
    const write = Promise.withResolvers<unknown>()
    transport.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        return write.promise
      }
      if (method === 'agentSession.modelCatalog') {
        return Promise.resolve({ origin: 'probe', models: answer.models, fetchedAt: 1 })
      }
      if (method !== 'agentSession.options') {
        return new Promise(() => {})
      }
      const read = Promise.withResolvers<AgentSessionOptionsResult>()
      reads.push(read)
      return read.promise
    })
    const hook = renderHook(
      ({ stamp, fence }) =>
        useStructuredAgentSessionOptions({
          agent: 'codex',
          sessionId,
          target,
          fence,
          transportEnabled: true,
          isVisible: true,
          providerVisible: true,
          turnId: null,
          unloadedTurnRevisions: undefined,
          hostOptionStamp: stamp,
          mutate: unavailableMutation
        }),
      { initialProps: { stamp: 'initial', fence: 1 } }
    )
    const owner = structuredSessionSelectionController(target, sessionId, 'codex')
    await waitFor(() => expect(reads).toHaveLength(1))
    await act(async () => reads[0].resolve(answer))
    const descriptor = (id: string) =>
      hook.result.current.optionSnapshot.find((row) => row.id === id)
    const capture = () => {
      const source = hook.result.current.sendSource
      return structuredAgentSessionMessageSelection(
        source.optionView(source.optionStateRef.current, undefined)
      )
    }
    expect(descriptor('model')?.kind).toMatchObject({ currentValue: 'gpt-5.5' })
    expect(descriptor('permissionMode')).toMatchObject({
      description: 'Full access',
      settable: true
    })
    let picked: Promise<boolean> | undefined
    if (pending) {
      act(() => {
        picked = hook.result.current.setStructuredOption('model', 'gpt-5.4')
      })
    }
    hook.rerender({ stamp: 'old-read', fence: 1 })
    await waitFor(() => expect(reads).toHaveLength(2))
    act(() => publish('answered-runtime-2', 2))
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(3))
    expect(structuredSessionSelectionController(target, sessionId, 'codex')).toBe(owner)
    const model = pending ? 'gpt-5.4' : 'gpt-5.5'
    expect(descriptor('model')?.kind).toMatchObject({ currentValue: model })
    expect(capture()).toEqual({ model })
    expect(hook.result.current.sendSource.optionStateRef.current.acceptedInputSources).toEqual({
      model: 'saved'
    })
    expect(descriptor('permissionMode')).toMatchObject({
      description: 'Permissions',
      settable: false
    })
    await act(async () =>
      reads[1].resolve({
        ...answer,
        conversationCommands: ['compact'],
        current: { model: 'stale' }
      })
    )
    expect(hook.result.current.conversationCommands).toEqual([])
    if (pending) {
      await act(async () => write.resolve({ ok: true, value: { options: { model } } }))
      await expect(picked).resolves.toBe(true)
      expect(owner.captureRead()).toHaveLength(1)
    }
    await act(async () =>
      reads[2].resolve({ ...answer, current: { model: 'gpt-5.5', acceptedInputSources: {} } })
    )
    if (pending) {
      await waitFor(() => expect(reads).toHaveLength(4))
      expect(owner.captureRead()).toHaveLength(1)
    }
    if (reads[3]) {
      await act(async () =>
        reads[3].resolve({ ...answer, current: { model: 'gpt-5.5', acceptedInputSources: {} } })
      )
    }
    await waitFor(() =>
      expect(hook.result.current.sendSource.optionStateRef.current.acceptedInputSources).toEqual({})
    )
    expect(owner.captureRead()).toEqual([])
    expect(descriptor('model')?.kind).toMatchObject({ currentValue: 'gpt-5.5' })
    expect(capture()).toEqual({})
    act(() => forgetStructuredSessionSelection(sessionId, target))
    hook.rerender({ stamp: 'new-owner', fence: 2 })
    expect(structuredSessionSelectionController(target, sessionId, 'codex')).not.toBe(owner)
    await waitFor(() =>
      expect(hook.result.current.sendSource.optionStateRef.current.optionsAnswerPresent).not.toBe(
        true
      )
    )
    expect(capture()).toEqual({})
    await expect(owner.request(async () => 'unsafe')).rejects.toThrow('retired')
  }
)

it('releases the actual first-publication observer when its owner ends before publication', async () => {
  useAppStore.getState().setRuntimeEnvironments([])
  useAppStore.setState({ runtimeEnvironmentCatalogHydrated: false })
  const released = vi.fn()
  const restore = registerStructuredSelectionCatalogStore({
    read: useAppStore.getState,
    subscribe(listener) {
      const stop = useAppStore.subscribe(listener)
      return () => {
        released()
        stop()
      }
    }
  })
  try {
    const owner = structuredSessionSelectionController(target, sessionId, 'codex')
    const pick = owner.issue('model', 'gpt-5.4', null)
    forgetStructuredSessionSelection(sessionId, target)
    await expect(pick.result).resolves.toEqual({ kind: 'superseded' })
    expect(released).toHaveBeenCalledTimes(1)
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    expect(released).toHaveBeenCalledTimes(1)
    await expect(owner.request(async () => 'unsafe')).rejects.toThrow('retired')
    const replacement = structuredSessionSelectionController(target, sessionId, 'codex')
    expect(replacement).not.toBe(owner)
    await expect(replacement.request(async (options) => options)).resolves.toEqual({
      expectedEnvironmentPairingRevision: 1
    })
  } finally {
    forgetStructuredSessionSelection(sessionId, target)
    restore()
  }
})
