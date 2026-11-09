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
import { registerCreateSelectionAdmissionTests } from './structured-agent-session-launch-selection-admission.test-fixture'
import { registerCreateHydrationTests } from './structured-agent-session-launch-hydration.test-fixture'
import { registerCreateCompletionTests } from './structured-agent-session-launch-completion.test-fixture'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { isStructuredAgentSessionMainAgentWorking } from '../../../../../shared/agent-session/view/structured-agent-session-main-agent-working'
import { structuredAgentSessionStopControl } from '../../../../../shared/agent-session/view/structured-agent-session-stop-control'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerActionEffortCreateTests } from './structured-agent-session-launch-action-effort.test-fixture'
import { registerCreateSelectionTests } from './structured-agent-session-create-selection.test-fixture'

import {
  startStructuredAgentLaunch,
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'
import { getStructuredAgentLaunchStatus } from './structured-agent-session-launch-status'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/host-access/use-native-chat-provisional-launch'
import { renderHook } from '@testing-library/react'
import { recheckUnconfirmedStructuredAgentLaunches } from './structured-agent-session-launch-unconfirmed-recheck'
import {
  settleStructuredAgentSessionSendsFromJournal,
  resetStructuredAgentSessionSendsForTests
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import {
  holdStructuredAgentSessionLaunchOption,
  structuredLaunchOptionOverlay
} from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from './routing/agent-launch-request-id'
import { markStructuredAgentSessionLaunchPublished } from './structured-agent-session-launch-publication'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'

import { writeNativeChatDraftCache } from '@/components/native-chat/drafts/native-chat-draft-views'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'

import {
  CreateIntentParams,
  SendParams
} from '../../../../../shared/rpc-contract/structured-agent-session-params'

import { structuredSessionSelectionController } from '../options/structured-agent-session-selection-controller'

let restoreCatalogStore: (() => void) | undefined
describe('the first message owned by create', () => {
  beforeEach(() => {
    restoreCatalogStore = resetCreateMessageFixture()
  })
  afterEach(() => {
    cleanupCreateMessageFixture(restoreCatalogStore)
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

  it('leaves a learned configured model and its effort to the agent', async () => {
    mocks.exactSupport.mockResolvedValue(true)
    recordHostModelCatalogSnapshot(target, 'claude', null, {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true,
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          defaultEffort: 'high',
          declaredDefaultEffort: 'low',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    })
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text'
    })
    await launch.launchResult
    expect(createParams().options).toBeUndefined()
    expect(createParams().firstMessage?.selection).toEqual({})
    expect(createParams().envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...createParams() })
    )
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
  registerCreateSelectionTests()
  registerCreateSelectionAdmissionTests()

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

  it.each([0, 30_000])(
    'returns a refused create once after %ims and the new draft',
    async (delay) => {
      const create = deferred<unknown>()
      mocks.call.mockReturnValue(create.promise)
      const launch = start()
      const held = !delay
        ? holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'gpt-5.4')
        : null
      const state = getStructuredLaunchStateBySessionId(launch.sessionId)
      if (state && !delay) {
        state.intent.surfaceAddress = { worktreeId: 'workspace-1', precedingTabIds: [] }
      }
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const raw = state?.promise
      if (delay) {
        await vi.advanceTimersByTimeAsync(delay)
        await expect(launch.launchResult).rejects.toThrow('Opening message outcome unknown.')
      }
      writeNativeChatDraftCache(
        structuredAgentSessionDraftScopeKey(launch.sessionId),
        'typed meanwhile'
      )
      create.resolve({
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported', message: 'unavailable' }
      })
      await expect(raw).rejects.toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
      await launch.promptDeliveryResult?.catch(() => undefined)
      expect(draft(launch.sessionId)).toBe('typed meanwhile\n\nopening text')
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
      if (delay) {
        const view = renderHook(() =>
          useNativeChatProvisionalLaunch('workspace-1', launch.sessionId)
        )
        expect(view.result.current.lifecycle).toBe('failed')
        view.unmount()
      } else {
        expect(findStructuredAgentSessionReadOwner(launch.sessionId, target)).toBeUndefined()
      }
      if (held) {
        await expect(held).resolves.toEqual({ kind: 'superseded' })
      }
    }
  )

  registerCreateCompletionTests()
  registerCreateHydrationTests()

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

  it.each([false, true])(
    'bounds preissue capability waiting with caller-owned input=%s',
    async (callerKeeps) => {
      const support = deferred<boolean>()
      mocks.supports.mockReturnValue(support.promise)
      mocks.call.mockImplementation(async () => created())
      const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        prompt: 'opening text',
        ...(callerKeeps ? { promptKeptByCaller: true as const } : {})
      })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(draft(launch.sessionId)).toBe(callerKeeps ? '' : 'opening text')
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        ...(callerKeeps ? {} : { inComposer: true })
      })
      expect(draft(launch.sessionId)).toBe(callerKeeps ? '' : 'opening text')
      support.resolve(true)
      await expect(launch.launchResult).rejects.toThrow('Opening input retired before create.')
      await Promise.resolve()
      expect(mocks.call).not.toHaveBeenCalled()
      expect(draft(launch.sessionId)).toBe(callerKeeps ? '' : 'opening text')
    }
  )

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

  it.each(['cached', 'disk'])(
    'reopens %s opening content without replay on a limited history page',
    async (source) => {
      mocks.call.mockReturnValue(new Promise(() => {}))
      mocks.supportsMode.mockResolvedValue(false)
      const resumeFrom = { providerSessionId: 'provider-session-1' }
      const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        prompt: 'opening text',
        resumeFrom,
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
      const saved = readStructuredAgentLaunchRecord(launch.sessionId)
      const page = created().value.page
      page.submissions = []
      resetStructuredAgentLaunchRegistryForTests()
      if (source === 'disk') {
        resetStructuredAgentLaunchPersistenceForTests()
      }
      resetStructuredAgentSessionSendsForTests()
      mocks.inventory.mockResolvedValue([
        { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
      ])
      mocks.call.mockResolvedValue({ ok: true, page })
      markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
      await vi.waitFor(() =>
        expect(
          mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.history')
        ).toHaveLength(1)
      )
      await Promise.resolve()
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toEqual({
        ...saved,
        lifecycle: 'visibility-unknown'
      })
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toMatchObject([
        {
          clientMessageId: original.firstMessage?.clientMessageId,
          body: original.firstMessage?.body,
          options: original.options,
          phase: 'unconfirmed'
        }
      ])
      recheckUnconfirmedStructuredAgentLaunches('local')
      await vi.waitFor(() =>
        expect(
          mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.history')
        ).toHaveLength(2)
      )
      const joined = startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        resumeFrom
      })
      expect(joined.sessionId).toBe(launch.sessionId)
      await expect(joined.launchResult).rejects.toThrow('Opening message outcome unknown.')
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      ).toHaveLength(1)
      expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual(
        []
      )
      for (const population of [20, 200]) {
        let reads = 0
        const unrelated = Array.from({ length: population }, (_, index) => ({
          ...submission(`unrelated-${index}`),
          get reason() {
            reads += 1
            return null
          }
        }))
        settleStructuredAgentSessionSendsFromJournal(launch.sessionId, unrelated, [])
        expect(reads).toBe(population)
      }

      expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
        original.firstMessage
      )
      settleStructuredAgentSessionSendsFromJournal(
        launch.sessionId,
        [submission(original.firstMessage?.clientMessageId ?? '')],
        []
      )
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
      let completedReads = 0
      settleStructuredAgentSessionSendsFromJournal(
        launch.sessionId,
        [
          {
            ...submission('unrelated-after-completion'),
            get reason() {
              completedReads += 1
              return null
            }
          }
        ],
        []
      )
      expect(completedReads).toBe(0)
      const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      expect(creates).toHaveLength(1)
      expect(creates[0]?.[2]).toEqual(original)
      expect(mocks.supports).toHaveBeenCalledOnce()
      expect(draft(launch.sessionId)).toBe('')
    }
  )

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

  it.each([false, true])(
    'observes reconnect without rearming startup when published=%s',
    async (published) => {
      mocks.call.mockReturnValue(new Promise(() => {}))
      const launch = start()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const original = createParams()
      await vi.advanceTimersByTimeAsync(30_000)
      await launch.promptDeliveryResult
      mocks.inventory.mockResolvedValue(
        published
          ? [
              {
                worktree: 'workspace-1',
                tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
              }
            ]
          : []
      )
      recheckUnconfirmedStructuredAgentLaunches('local')
      if (published) {
        await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      }
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getStructuredAgentLaunchStatus('workspace-1', 'codex')).toBe('idle')
      expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
        original.firstMessage
      )
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      ).toHaveLength(1)
      expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual(
        []
      )
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('unconfirmed')
      expect(draft(launch.sessionId)).toBe('')
    }
  )
})
