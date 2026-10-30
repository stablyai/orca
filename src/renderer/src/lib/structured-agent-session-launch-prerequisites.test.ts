// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  createParams,
  created,
  target,
  draft,
  legacyAction,
  acceptedOption,
  refusedOption,
  optionCalls
} from './structured-agent-session-launch-create-message.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  holdStructuredAgentSessionLaunchOption,
  structuredLaunchSelectionController,
  flushStructuredSessionSelectionOptions
} from './structured-agent-session-launch-options'
import {
  structuredSessionSelectionController,
  forgetStructuredSessionSelection
} from './structured-agent-session-selection-controller'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchRecord
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { getStructuredAgentSessionSendNotice } from '@/components/native-chat/structured-agent-session-pending-sends'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { recoverPublishedSessionReceipt } from './agent-session/launch/structured-agent-session-launch-recovery'
import { publishStructuredLaunchCreateOptions } from './structured-agent-session-launch-create-message'
import {
  retryStructuredAgentSessionLaunch,
  getStructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch'

let restoreCatalogStore: (() => void) | undefined
describe('legacy opening action prerequisites through real launch orchestration', () => {
  beforeEach(() => {
    restoreCatalogStore = resetCreateMessageFixture()
  })
  afterEach(() => {
    cleanupCreateMessageFixture(restoreCatalogStore)
  })

  it.each([
    ['model', 'picked-model'],
    ['effort', 'low'],
    ['serviceTier', 'priority'],
    ['fastMode', 'true'],
    ['permissionMode', 'full-access']
  ])(
    'returns required held %s failure through actual publication and prompt',
    async (key, value) => {
      const unrelated = deferred<unknown>()
      const { launch, create } = legacyAction(
        { model: 'action-model', effort: 'high' },
        async (field, encoded) =>
          field === key
            ? refusedOption
            : key === 'model' && field === 'permissionMode'
              ? unrelated.promise
              : acceptedOption(field, encoded),
        'local',
        key === 'fastMode' ? 'claude' : 'codex'
      )
      const preference =
        key === 'model'
          ? holdStructuredAgentSessionLaunchOption(launch.sessionId, 'permissionMode', 'ask')
          : null
      const held = holdStructuredAgentSessionLaunchOption(launch.sessionId, key, value)!
      await vi.waitFor(() => expect(createParams()).toBeDefined())
      create.resolve(created())
      await expect(held).resolves.toMatchObject({ kind: 'refused' })
      await expect(launch.launchResult).resolves.toHaveProperty('configurationFailure')
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        inComposer: true
      })
      expect(draft(launch.sessionId)).toBe('opening text')
      expect(getStructuredAgentSessionSendNotice(launch.sessionId)).toContain(
        key === 'fastMode' ? 'Claude' : 'Codex'
      )
      expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.send')).toBe(false)
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(false)
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(optionCalls().filter((call) => call.key === key)).toHaveLength(1)
      if (key === 'effort') {
        expect(optionCalls().map((call) => call.key)).toEqual(['model', 'effort'])
      }
      if (preference) {
        expect(optionCalls().filter((call) => call.key === 'permissionMode')).toHaveLength(1)
        unrelated.resolve(acceptedOption('permissionMode', 'ask'))
        await expect(preference).resolves.toMatchObject({ kind: 'accepted' })
      }
    }
  )

  it.each([false, true])(
    'keeps held unknown nonblocking only without explicit action (%s)',
    async (explicit) => {
      const { launch, create } = legacyAction(
        explicit ? { model: 'action-model', effort: 'high' } : undefined,
        async () => {
          throw new Error('runtime_unavailable')
        }
      )
      const held = holdStructuredAgentSessionLaunchOption(
        launch.sessionId,
        'model',
        'picked-model'
      )!
      await vi.waitFor(() => expect(createParams()).toBeDefined())
      create.resolve(created())
      await expect(held).resolves.toMatchObject({
        kind: 'unknown',
        failure: { kind: 'unconfirmed' }
      })
      const receipt = await launch.launchResult
      expect(receipt.configurationFailure !== undefined).toBe(explicit)
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: !explicit })
      expect(optionCalls()).toHaveLength(1)
    }
  )

  it('rederives unsent dependents from retained exact handles and enrolls a later visited field', async () => {
    const model = deferred<unknown>()
    const effort = deferred<unknown>()
    const writes: { key: string; value: string }[] = []
    const { launch, create } = legacyAction(
      { model: 'B', effort: 'high', serviceTier: 'default' },
      async (key, value) => {
        writes.push({ key, value })
        return writes.length === 1
          ? model.promise
          : key === 'effort'
            ? effort.promise
            : acceptedOption(key, value)
      }
    )
    const obsolete = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'B')!
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'C')
    const newest = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'B')!
    await expect(obsolete).resolves.toEqual({ kind: 'superseded' })
    await vi.waitFor(() => expect(createParams()).toBeDefined())
    create.resolve(created())
    await vi.waitFor(() => expect(writes).toEqual([{ key: 'model', value: 'B' }]))
    const owner = structuredLaunchSelectionController(
      getStructuredLaunchStateBySessionId(launch.sessionId)!
    )
    const first = owner.current('model')!
    expect(first.transmitted).toBe(true)
    // A current query may retire the picker object before the action continuation.
    const stopRead = owner.subscribe(() => {
      const terminal = owner.captureRead()
      if (terminal.length) {
        stopRead()
        owner.retire(terminal)
      }
    })
    const later = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'C')!
    await expect(later).resolves.toMatchObject({ kind: 'accepted' })
    expect(owner.current('model')).toBeUndefined()
    model.resolve(acceptedOption('model', 'B'))
    await expect(newest).resolves.toMatchObject({ kind: 'accepted' })
    await vi.waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[2]).toEqual({ key: 'effort', value: 'medium' })
    effort.resolve(acceptedOption('effort', 'medium'))
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(writes.map(({ key, value }) => [key, value])).toEqual([
      ['model', 'B'],
      ['model', 'C'],
      ['effort', 'medium']
    ])
  })

  it('preserves transmitted required failure after newer success and joins actual recovered reentry', async () => {
    const older = deferred<unknown>()
    const { launch, create } = legacyAction(
      { model: 'action-model', effort: 'high' },
      async (key, value) => (value === 'B' ? older.promise : acceptedOption(key, value))
    )
    const b = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'B')!
    await vi.waitFor(() => expect(createParams()).toBeDefined())
    create.resolve(created())
    await vi.waitFor(() => expect(optionCalls()).toHaveLength(1))
    const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
    const c = holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'C')!
    await expect(c).resolves.toMatchObject({ kind: 'accepted' })
    const original = state.intent
    // Drive the real recovery→publication chain with its legitimate successor receipt.
    const recovered = recoverPublishedSessionReceipt(state).then((receipt) =>
      publishStructuredLaunchCreateOptions(state, receipt)
    )
    await vi.waitFor(() =>
      expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.history')).toBe(
        true
      )
    )
    expect(state.intent).toBe(original)
    older.resolve(refusedOption)
    await expect(b).resolves.toMatchObject({ kind: 'refused' })
    await expect(launch.launchResult).resolves.toHaveProperty('configurationFailure')
    await expect(recovered).resolves.toMatchObject({ fence: 2, configurationFailure: {} })
    await expect(
      recoverPublishedSessionReceipt(state).then((receipt) =>
        publishStructuredLaunchCreateOptions(state, receipt)
      )
    ).resolves.toMatchObject({ fence: 2, configurationFailure: {} })
    expect(optionCalls().map(({ value }) => value)).toEqual(['B', 'C'])
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
    ).toHaveLength(0)
  })

  it('enrolls actual attached-owner requests before dispatch and hands unrelated picker work off on failure', async () => {
    const model = deferred<unknown>()
    const { launch, create } = legacyAction(
      { model: 'action-model', effort: 'high' },
      (key, value) =>
        key === 'model'
          ? model.promise
          : key === 'permissionMode'
            ? Promise.resolve(refusedOption)
            : Promise.resolve(acceptedOption(key, value))
    )
    await vi.waitFor(() => expect(createParams()).toBeDefined())
    create.resolve(created())
    await vi.waitFor(() => expect(optionCalls()).toHaveLength(1))
    const owner = structuredLaunchSelectionController(
      getStructuredLaunchStateBySessionId(launch.sessionId)!
    )
    const pick = owner.issue('permissionMode', 'full-access', 'action-model')
    void flushStructuredSessionSelectionOptions(target, launch.sessionId, 1, owner)
    model.resolve(acceptedOption('model', 'action-model'))
    await expect(pick.result).resolves.toMatchObject({ kind: 'refused' })
    await expect(launch.launchResult).resolves.toHaveProperty('configurationFailure')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true
    })
    expect(optionCalls().filter((call) => call.key === 'permissionMode')).toHaveLength(1)
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
    ).toHaveLength(0)
  })

  it('returns the real keyless original-owner failure and one user Retry never rebinds option writes', async () => {
    const paired = { kind: 'environment', environmentId: 'legacy-original' } as const
    replaceRuntimeEnvironmentRevisions([{ id: paired.environmentId, createdAt: 1 }])
    const raw = deferred<unknown>()
    const { launch, create } = legacyAction(
      { model: 'action-model' },
      () => raw.promise,
      'runtime:legacy-original'
    )
    await vi.waitFor(() => expect(createParams()).toBeDefined())
    create.resolve(created())
    await vi.waitFor(() => expect(optionCalls()).toHaveLength(1))
    const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
    const original = state.intent
    const owner = structuredLaunchSelectionController(state)
    replaceRuntimeEnvironmentRevisions([{ id: paired.environmentId, createdAt: 2 }])
    await expect(launch.launchResult).rejects.toThrow('owner retired')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe('failed')
    raw.resolve(acceptedOption('model', 'action-model'))
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await expect(state.promise).rejects.toThrow('owner retired')
    expect(state.intent).not.toBe(original)
    expect(structuredLaunchSelectionController(state)).toBe(owner)
    expect(optionCalls()).toHaveLength(1)
    const targets = mocks.call.mock.calls.map(([host, method]) => ({ host, method }))
    expect(targets).toEqual([
      { host: paired, method: 'agentSession.create' },
      { host: paired, method: 'agentSession.setOption' },
      { host: paired, method: 'agentSession.create' }
    ])
    expect(mocks.admit).toHaveBeenCalledTimes(2)
    expect(draft(launch.sessionId)).toBe('opening text')
    forgetStructuredSessionSelection(launch.sessionId, paired)
    replaceRuntimeEnvironmentRevisions([])
  })

  it('bounds real late enrollment work and releases its scoped observation at N and 10N', async () => {
    const work: number[] = []
    for (const count of [10, 100]) {
      const waiting = deferred<unknown>()
      const { launch, create } = legacyAction({ model: 'action-model' }, (key, value) =>
        key === 'model' ? waiting.promise : Promise.resolve(acceptedOption(key, value))
      )
      const state = getStructuredLaunchStateBySessionId(launch.sessionId)!
      holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'action-model')
      holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
      const owner = structuredLaunchSelectionController(state)
      let subscriptions = 0
      const subscribe = owner.subscribe
      const observation = vi.spyOn(owner, 'subscribe').mockImplementation((listener) => {
        subscriptions++
        const stop = subscribe(listener)
        return () => {
          subscriptions--
          stop()
        }
      })
      let visits = 0
      const issue = owner.issue
      const access = vi.spyOn(owner, 'issue').mockImplementation((...args) => {
        const operation = issue(...args)
        for (const key of ['identity', 'key', 'outcome', 'transmitted'] as const) {
          let value = operation[key]
          Object.defineProperty(operation, key, {
            configurable: true,
            get() {
              visits++
              return value
            },
            set(next) {
              value = next
            }
          })
        }
        return operation
      })
      await vi.waitFor(() => expect(createParams()).toBeDefined())
      create.resolve(created())
      await vi.waitFor(() => expect(optionCalls()).toHaveLength(2))
      for (let index = 0; index < count; index++) {
        const before = visits
        const pick = holdStructuredAgentSessionLaunchOption(
          launch.sessionId,
          'permissionMode',
          index % 2 ? 'ask' : 'full-access'
        )!
        await expect(pick).resolves.toMatchObject({ kind: 'accepted' })
        expect(visits - before).toBeLessThanOrEqual(80)
      }
      waiting.resolve(acceptedOption('model', 'action-model'))
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
      expect(subscriptions).toBe(0)
      expect(owner.pending()).toEqual([])
      expect(optionCalls().filter((call) => call.key === 'permissionMode')).toHaveLength(count)
      work.push(visits)
      observation.mockRestore()
      access.mockRestore()
      resetStructuredAgentLaunchRegistryForTests()
      resetStructuredAgentLaunchPersistenceForTests()
      forgetStructuredSessionSelection(launch.sessionId)
      mocks.call.mockClear()
    }
    console.info(
      'legacy-phase-property-work',
      JSON.stringify({ populations: [10, 100], visits: work })
    )
    expect(work[1]).toBeLessThanOrEqual(work[0] * 10)
  })

  it.each([false, true])(
    'releases never-returning %s required requests at true end without reviving equal-text owners',
    async (held) => {
      const raw = deferred<unknown>()
      const { launch, create } = legacyAction({ model: 'action-model' }, () => raw.promise)
      if (held) {
        holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'B')
      }
      await vi.waitFor(() => expect(createParams()).toBeDefined())
      create.resolve(created())
      await vi.waitFor(() => expect(optionCalls()).toHaveLength(1))
      const owner = structuredLaunchSelectionController(
        getStructuredLaunchStateBySessionId(launch.sessionId)!
      )
      const other = structuredSessionSelectionController(
        { kind: 'environment', environmentId: 'other-legacy' },
        launch.sessionId,
        'codex'
      )
      other.issue('model', 'other', null)
      forgetStructuredSessionSelection(launch.sessionId, target)
      await expect(launch.launchResult).rejects.toThrow('owner retired')
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: false })
      expect(draft(launch.sessionId)).toBe('opening text')
      const replacement = structuredSessionSelectionController(target, launch.sessionId, 'codex')
      expect(replacement).not.toBe(owner)
      expect(other.overlay()).toEqual({ model: 'other' })
      raw.resolve(acceptedOption('model', 'B'))
      await Promise.resolve()
      expect(replacement.overlay()).toEqual({})
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
      ).toHaveLength(0)
      forgetStructuredSessionSelection(launch.sessionId)
    }
  )
})
