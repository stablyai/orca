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
  draft
} from './structured-agent-session-launch-create-message.test-fixture'
import { registerCreateSelectionAdmissionTests } from './structured-agent-session-launch-selection-admission.test-fixture'
import { registerCreateHydrationTests } from './structured-agent-session-launch-hydration.test-fixture'
import { registerCreateCompletionTests } from './structured-agent-session-launch-completion.test-fixture'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerActionEffortCreateTests } from './structured-agent-session-launch-action-effort.test-fixture'
import { registerCreateSelectionTests } from './structured-agent-session-create-selection.test-fixture'

import {
  startStructuredAgentLaunch,
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from './structured-agent-session-launch'

import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'

import { newAgentLaunchRequestId } from './routing/agent-launch-request-id'

import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner'
import { findStructuredAgentSessionReadOwner } from '@/components/native-chat/session/structured/read/structured-agent-session-read-owner-registry'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'

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

  registerActionEffortCreateTests(mocks, created)
  registerCreateSelectionTests()
  registerCreateSelectionAdmissionTests()

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
})
