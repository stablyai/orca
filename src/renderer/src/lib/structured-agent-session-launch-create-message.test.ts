// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  layoutOwner,
  deferred,
  createParams,
  submission,
  created,
  target,
  start,
  draft,
  startLegacyActionLaunch
} from './structured-agent-session-launch-create-message.test-fixture'
import { useAppStore } from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CreateIntentParams,
  SendParams
} from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { registerActionEffortCreateTests } from './structured-agent-session-launch-action-effort.test-fixture'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'

import {
  startStructuredAgentLaunch,
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch,
  getStructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch'
import {
  registerStructuredSelectionCatalogStore,
  structuredSessionSelectionController,
  forgetStructuredSessionSelection
} from './structured-agent-session-selection-controller'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status-connection-generation'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  holdStructuredAgentSessionLaunchOption,
  structuredLaunchOptionOverlay
} from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchRecord
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { markStructuredAgentSessionLaunchPublished } from './agent-session/launch/structured-agent-session-launch-publication'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner
} from '@/components/native-chat/structured-agent-session-read-owner'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredAgentSessionStopControl } from '../../../shared/structured-agent-session-stop-control'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
let restoreCatalogStore: (() => void) | undefined
describe('the first message owned by create', () => {
  beforeEach(() => {
    restoreCatalogStore = resetCreateMessageFixture()
  })
  afterEach(() => {
    cleanupCreateMessageFixture(restoreCatalogStore)
  })

  it('requires registered authority before inserting a remote selection owner', () => {
    restoreCatalogStore?.()
    const remote = { kind: 'environment', environmentId: 'uncomposed-test-store' } as const
    expect(() => structuredSessionSelectionController(remote, 'uncomposed', 'codex')).toThrow(
      'must be registered'
    )
    const restore = registerStructuredSelectionCatalogStore({
      read: useAppStore.getState,
      subscribe: useAppStore.subscribe
    })
    try {
      const owner = structuredSessionSelectionController(remote, 'uncomposed', 'codex')
      expect(structuredSessionSelectionController(remote, 'uncomposed', 'codex')).toBe(owner)
    } finally {
      forgetStructuredSessionSelection('uncomposed', remote)
      restore()
    }
  })

  it('freezes the message and held options in create and publishes without another read or send', async () => {
    mocks.exactSupport.mockResolvedValue(true)
    recordHostModelCatalogSnapshot(target, 'codex', null, {
      origin: 'probe',
      fetchedAt: 1,
      defaultHoldsInEveryWorkspace: true,
      models: [
        {
          id: 'picked-model',
          label: 'Picked',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    })
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'picked-model')
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const params = createParams()
    expect(params.firstMessage?.body.blocks).toEqual([{ type: 'text', text: 'opening text' }])
    expect(params.options).toEqual({ model: 'picked-model', effort: 'high' })
    expect(params.firstMessage?.selection).toEqual({ model: 'picked-model', effort: 'high' })
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
    )
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('sending')
    const stop = vi.fn(async () => null)
    expect(
      structuredAgentSessionStopControl({
        published: false,
        host: { stopsConversation: true, stop },
        transportState: { turnId: null, isWorking: false },
        sends: { sending: true, stopSends: vi.fn() }
      }).canStop
    ).toBe(false)
    create.resolve(created())
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    const state = getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state
    expect(state.fence).toBe(1)
    const isWorking = isStructuredAgentSessionMainAgentWorking(null, state.submissions, state.fence)
    expect(isWorking).toBe(true)
    const control = structuredAgentSessionStopControl({
      published: true,
      host: { stopsConversation: true, stop },
      transportState: { turnId: null, isWorking },
      sends: { sending: false, stopSends: vi.fn() }
    })
    expect(control.canStop).toBe(true)
    await control.stop()
    expect(stop).toHaveBeenCalledWith(null, expect.any(Function))
    expect(draft(launch.sessionId)).toBe('')
    expect(mocks.inventory).not.toHaveBeenCalled()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it.each([
    ['new', {}],
    ['resumed', { resumeFrom: { providerSessionId: 'provider-session-1' } }]
  ])('keeps remembering in its owning lifetime, %s', async (_kind, resume) => {
    mocks.exactSupport.mockResolvedValue(true)
    mocks.settings = {
      nativeChatSessionOptions: {
        claude: { model: 'claude-gone' }
      }
    }
    const xhigh = [{ value: 'xhigh', label: 'xhigh' }]
    recordHostModelCatalogSnapshot(target, 'claude', null, {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus[1m]', label: 'Opus', isDefault: true, efforts: xhigh }]
    })
    mocks.call.mockImplementation(async () => created())
    try {
      const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        prompt: 'opening text',
        ...resume
      })
      await launch.launchResult
      expect(createParams().options?.model).toBe(
        'resumeFrom' in resume && resume.resumeFrom ? undefined : 'claude-gone'
      )
      expect(createParams().firstMessage?.selection).toEqual(
        'resumeFrom' in resume && resume.resumeFrom ? {} : { model: 'claude-gone' }
      )
    } finally {
      mocks.settings = {}
    }
  })

  registerActionEffortCreateTests(mocks, created)

  it.each(['codex', 'claude'] as const)(
    'creates %s on an unlisted explicit model without importing saved effort',
    async (agent) => {
      mocks.settings = {
        nativeChatSessionOptions: {
          [agent]: { model: 'saved-model', valuesByModel: { 'saved-model': { effort: 'low' } } }
        }
      }
      mocks.call.mockImplementation(async () => created())
      try {
        const launch = startStructuredAgentLaunch('workspace-1', agent, {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          launchOptions: { model: 'unlisted-action-model' }
        })
        expect(readStructuredAgentLaunchRecord(launch.sessionId)?.explicitLaunchOptions).toEqual({
          model: 'unlisted-action-model'
        })
        expect(
          structuredLaunchOptionOverlay(getStructuredLaunchStateBySessionId(launch.sessionId)!)
        ).toEqual({})
        await launch.launchResult
        expect(createParams().optionsMode).toBe('replace-model-selection')
        expect(createParams().options).toEqual({
          model: 'unlisted-action-model',
          permissionMode: 'ask'
        })
      } finally {
        mocks.settings = {}
      }
    }
  )

  it.each([
    ['a permission-only action leaves the remembered model', undefined, undefined],
    [
      'a model picked during launch keeps the action mode',
      'picked-model',
      'replace-model-selection'
    ]
  ])('%s', async (_name, picked, optionsMode) => {
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: picked
        ? { model: 'action-model', effort: 'high', permissionMode: 'full-access' }
        : { permissionMode: 'full-access' }
    })
    if (picked) {
      holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', picked)
    }
    await launch.launchResult
    expect(createParams().optionsMode).toBe(optionsMode)
    expect(createParams().options).toEqual({
      permissionMode: 'full-access',
      ...(picked ? { model: picked } : {})
    })
  })

  it('leaves a host without options-mode on its own new-chat permission mode', async () => {
    mocks.supportsMode.mockResolvedValue(false)
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: { permissionMode: 'full-access' }
    })
    await launch.launchResult
    expect(createParams().options).toBeUndefined()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it('carries a held tier as the picker draws it, keeps the pick through a refusal, and settles it once', async () => {
    const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
    const efforts = tiers('medium', 'high')
    const list = (defaultId: string) => ({
      origin: 'probe' as const,
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true as const,
      models: [
        ['m1', 'priority'],
        ['m2', 'flex']
      ].map(([id, tier]) => ({
        id,
        label: id,
        isDefault: defaultId === id,
        efforts,
        serviceTiers: tiers(tier)
      }))
    })
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m1'))
    const refused = deferred<unknown>()
    const create = deferred<unknown>()
    mocks.call.mockReturnValueOnce(refused.promise).mockReturnValueOnce(create.promise)
    mocks.call.mockResolvedValue({ ok: true, value: { key: 'effort', value: 'medium' } })
    const launch = start()
    const tierPick = holdStructuredAgentSessionLaunchOption(
      launch.sessionId,
      'serviceTier',
      'priority'
    )
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
    // The account's default moves before create goes out: Fast runs as Standard under it.
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m2'))
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(createParams().options).toEqual({ effort: 'high', serviceTier: 'default' })
    refused.resolve({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'no' }
    })
    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m1'))
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const retried = CreateIntentParams.parse(mocks.call.mock.calls[1]?.[2])
    expect(retried.options).toEqual({ effort: 'high', serviceTier: 'priority' })
    // A pick made while create is out is newer than what it carries, so it applies after.
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'medium')
    create.resolve(created())
    await expect(tierPick).resolves.toEqual({
      kind: 'accepted',
      options: { effort: 'high', serviceTier: 'priority' }
    })
    await vi.waitFor(() =>
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.create',
        'agentSession.create',
        'agentSession.setOption'
      ])
    )
    expect(mocks.call.mock.calls[2]?.[2]).toMatchObject({ key: 'effort', value: 'medium' })
  })

  it('returns a refused create once after the new draft, with no later send', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    const held = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')!
    const state = getStructuredLaunchStateBySessionId(launch.sessionId)
    if (state) {
      state.intent.surfaceAddress = { worktreeId: 'workspace-1', precedingTabIds: [] }
    }
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    writeNativeChatDraftCache(
      structuredAgentSessionDraftScopeKey(launch.sessionId),
      'typed meanwhile'
    )
    create.resolve({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'unavailable' }
    })
    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await launch.promptDeliveryResult?.catch(() => undefined)
    expect(draft(launch.sessionId)).toBe('typed meanwhile\n\nopening text')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
    expect(findStructuredAgentSessionReadOwner(launch.sessionId, target)).toBeUndefined()
    await expect(held).resolves.toEqual({ kind: 'superseded' })
  })

  it('returns text at 30 seconds and a late create reply cannot send it again', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(draft(launch.sessionId)).toBe('opening text')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true,
      unconfirmed: true
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(draft(launch.sessionId)).toBe('opening text')
    create.resolve(created())
    await launch.launchResult
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it('keeps the old create-then-send payload for an older host', async () => {
    mocks.supports.mockResolvedValue(false)
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.create') {
        return created()
      }
      const send = SendParams.parse(params)
      return {
        ok: true,
        value: {
          clientMessageId: send.envelope.clientOperationId,
          submission: submission(send.envelope.clientOperationId)
        }
      }
    })
    const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: { fastMode: 'true' }
    })
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(createParams()).not.toHaveProperty('firstMessage')
    expect(createParams()).not.toHaveProperty('options')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.send'
    ])
  })

  it('a generated legacy effort refusal does not stop the opening prompt', async () => {
    const launch = startLegacyActionLaunch({ model: 'gpt-5.6-sol' }, 'effort', {
      code: 'agent_session_operation_invalid',
      message: 'unavailable'
    })
    const receipt = await launch.launchResult
    expect(receipt.configurationFailure).toBeUndefined()
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(
      mocks.call.mock.calls
        .filter(([, method]) => method === 'agentSession.setOption')
        .map(([, , params]) => params)
    ).toEqual([
      expect.objectContaining({ key: 'model', value: 'gpt-5.6-sol' }),
      expect.objectContaining({ key: 'effort', value: 'medium' })
    ])
    expect(createParams()).not.toHaveProperty('options')
    expect(draft(launch.sessionId)).toBe('')
  })

  it.each([
    { key: 'model', unknown: false },
    { key: 'effort', unknown: false },
    { key: 'model', unknown: true }
  ])(
    'keeps the legacy chat and text when required input fails: %j',
    async ({ key: refused, unknown }) => {
      const launch = startLegacyActionLaunch(
        { model: 'action-model', effort: 'high' },
        refused,
        unknown
          ? new Error('runtime_unavailable')
          : {
              code: 'agent_session_operation_invalid',
              details: { reason: 'optionRejected' },
              message: 'unavailable'
            }
      )
      const receipt = await launch.launchResult
      expect(receipt).toMatchObject({ sessionId: launch.sessionId, configurationFailure: {} })
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        inComposer: true,
        failureNotified: true
      })
      expect(draft(launch.sessionId)).toBe('opening text')
      expect(getStructuredAgentSessionSendNotice(launch.sessionId)).toContain('Codex')
      expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual(
        []
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(false)
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      ).toHaveLength(1)
    }
  )

  it('keeps the older host acquisition wait outside the send deadline', async () => {
    const create = deferred<unknown>()
    mocks.supports.mockResolvedValue(false)
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(45_000)
    expect(draft(launch.sessionId)).toBe('')
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('sending')
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const send = SendParams.parse(params)
      return {
        ok: true,
        value: {
          clientMessageId: send.envelope.clientOperationId,
          submission: submission(send.envelope.clientOperationId)
        }
      }
    })
    create.resolve(created())
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.send'
    ])
  })

  it('bounds the click even if capability negotiation has not answered', async () => {
    const support = deferred<boolean>()
    mocks.supports.mockReturnValue(support.promise)
    mocks.call.mockImplementation(async () => created())
    const launch = start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(draft(launch.sessionId)).toBe('opening text')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true
    })
    expect(draft(launch.sessionId)).toBe('opening text')
    support.resolve(true)
    await launch.launchResult
    expect(createParams()).not.toHaveProperty('firstMessage')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(draft(launch.sessionId)).toBe('opening text')
  })

  it('keeps the same first-message intent when the paired host reports its seed', async () => {
    mocks.admit.mockResolvedValue({ kind: 'admitted', seedOptions: { model: 'host-default' } })
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:server-1',
      prompt: 'opening text'
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(createParams().firstMessage?.body.blocks).toEqual([
      { type: 'text', text: 'opening text' }
    ])
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'agentSession.create',
      expect.objectContaining({ firstMessage: expect.any(Object) })
    )
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(
      getStructuredAgentSessionReadOwner(launch.sessionId, {
        kind: 'environment',
        environmentId: 'server-1'
      }).getSnapshot().state.fence
    ).toBe(1)
    expect(
      getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state.fence
    ).toBeNull()
  })

  it('enqueues two late picks before modern publication without waiting for acceptance', async () => {
    const create = deferred<unknown>()
    const replies = [deferred<unknown>(), deferred<unknown>()]
    let writes = 0
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.setOption' ? replies[writes++]!.promise : create.promise
    )
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'sonnet')
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
    create.resolve(created())
    let published = false
    void launch.launchResult.then(() => {
      published = true
    })
    await vi.waitFor(() => expect(published).toBe(true))
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.setOption',
      'agentSession.setOption'
    ])
    const controller = structuredSessionSelectionController(target, launch.sessionId, 'codex')
    expect(controller.pending()).toHaveLength(2)
    replies[1]!.resolve({ ok: true, value: { options: { effort: 'high' } } })
    replies[0]!.resolve({ ok: true, value: { options: { model: 'sonnet' } } })
    await vi.waitFor(() => expect(controller.captureRead()).toHaveLength(2))
  })

  it('recovers a reload by replaying the frozen create when the old row is outside history', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    mocks.supportsMode.mockResolvedValue(false)
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: { model: 'gpt-5.6-sol' }
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const original = createParams()
    expect(original.optionsMode).toBeUndefined()
    expect(original.options?.effort).toBe('medium')
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.explicitLaunchOptions).toEqual({
      model: 'gpt-5.6-sol'
    })
    mocks.supportsMode.mockResolvedValue(true)
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
      original.firstMessage
    )
    const response = created()
    const receipt = response.value.page.submissions[0]
    response.value.page.submissions = []
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentSessionSendsForTests()
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.history'
        ? { ok: true, page: response.value.page }
        : { ...response, replayed: true, value: { ...response.value, firstMessage: receipt } }
    )
    markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(2)
    expect(creates[1]?.[2]).toEqual(original)
    expect(mocks.supports).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
    expect(draft(launch.sessionId)).toBe('')
  })

  it('allows Retry after the deadline while the original create never answers', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const paired = { kind: 'environment', environmentId: 'frozen-generation' } as const
    replaceRuntimeEnvironmentRevisions([{ id: paired.environmentId, createdAt: 1 }])
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:frozen-generation',
      hostSeedOptions: { model: 'gpt-5.5' },
      prompt: 'opening text'
    })
    const first = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')!
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const original = createParams()
    const owner = structuredSessionSelectionController(paired, launch.sessionId, 'codex')
    const carried = owner.pending()[0]!
    await vi.advanceTimersByTimeAsync(30_000)
    await launch.promptDeliveryResult
    setRuntimeEnvironmentConnectionGenerationForTests(paired.environmentId, 2)
    expect(structuredSessionSelectionController(paired, launch.sessionId, 'codex')).toBe(owner)
    const middle = holdStructuredAgentSessionLaunchOption(
      launch.sessionId,
      'model',
      'gpt-5.3-codex'
    )!
    const newest = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')!
    await expect(middle).resolves.toEqual({ kind: 'superseded' })
    const applied = deferred<unknown>()
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.setOption' ? applied.promise : Promise.resolve(created())
    )
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(2)
    expect(creates[1]?.[2]).toEqual(original)
    await expect(first).resolves.toMatchObject({ kind: 'accepted' })
    expect(carried.outcome?.kind).toBe('accepted')
    expect(owner.pending()).toHaveLength(1)
    expect(owner.pending()[0]).not.toBe(carried)
    applied.resolve({ ok: true, value: { options: { model: 'gpt-5.4' } } })
    await expect(newest).resolves.toMatchObject({ kind: 'accepted' })
    expect(owner.captureRead()).toHaveLength(2)
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
    expect(draft(launch.sessionId)).toBe('opening text')
    replaceRuntimeEnvironmentRevisions([])
  })

  it.each([
    // A window-owned build leaves a cancellation record; this machine's host closes the chat itself.
    ['a window-owned', false, ['agentSession.create']],
    ['a layout-owner', true, ['agentSession.close', 'agentSession.create']]
  ])(
    'does not revive a closed conversation reader when create replies late, in %s build',
    async (_build, isMain, methods) => {
      layoutOwner.isMain = isMain
      const create = deferred<unknown>()
      mocks.call.mockImplementation((_target, method) =>
        method === 'agentSession.create' ? create.promise : Promise.resolve({})
      )
      const launch = start()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      expect(cancelStructuredAgentLaunch('workspace-1', launch.sessionId)).toBe(true)
      create.resolve(created())
      await expect(launch.launchResult).rejects.toThrow('structured session launch cancelled')
      expect(findStructuredAgentSessionReadOwner(launch.sessionId, target)).toBeUndefined()
      expect(mocks.call.mock.calls.map(([, method]) => method).sort()).toEqual(methods)
    }
  )

  it('keeps Retry actionable when a published tab starts an unanswered message confirmation', async () => {
    mocks.call.mockReturnValue(new Promise(() => {}))
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    await launch.promptDeliveryResult
    mocks.inventory.mockResolvedValue([
      {
        worktree: 'workspace-1',
        tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
      }
    ])
    expect(
      markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
    ).toBe(false)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(draft(launch.sessionId)).toBe('opening text')
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation(async () => created())
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.history',
      'agentSession.create'
    ])
    expect(draft(launch.sessionId)).toBe('opening text')
  })

  it.each(['create', 'history'] as const)(
    'offers Retry again when a second %s attempt never answers, without returning text twice',
    async (method) => {
      mocks.call.mockReturnValue(new Promise(() => {}))
      const launch = start()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const original = createParams()
      await vi.advanceTimersByTimeAsync(30_000)
      await launch.promptDeliveryResult
      mocks.inventory.mockResolvedValue(
        method === 'create'
          ? []
          : [
              {
                worktree: 'workspace-1',
                tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
              }
            ]
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
        'visibility-unknown'
      )
      expect(draft(launch.sessionId)).toBe('opening text')
      mocks.call.mockImplementation(async () =>
        method === 'history' ? { ok: true, page: created().value.page } : created()
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() =>
        expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      )
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.create',
        `agentSession.${method}`,
        `agentSession.${method}`
      ])
      expect(
        mocks.call.mock.calls
          .filter(([, name]) => name === 'agentSession.create')
          .map(([, , params]) => params)
      ).toEqual(method === 'create' ? [original, original, original] : [original])
      expect(draft(launch.sessionId)).toBe('opening text')
    }
  )
})
