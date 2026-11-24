// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  refreshRuntimeEnvironmentCatalog,
  setRuntimeEnvironmentCatalogRefresher
} from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import * as registry from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { runtimeEnvironmentChangedFailure } from '../../../../main/ipc/runtime-environments/requests/runtime-environment-revision-guard'
import { RUNTIME_PROTOCOL_VERSION } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { createBotHostRead } from './bot-host-read-store'
import { NO_ACTIVITY, type BotActivityWithAuthority } from './use-bot-activity'
import {
  useBotAutomationDelete,
  type BotAutomationDeleteAdmission
} from './use-bot-automation-delete'

const bot: BotRef = { hostId: 'runtime:paired', id: 'bot' }
const old: BotActivityWithAuthority = {
  authority: { kind: 'environment', environmentId: 'paired', pairingRevision: 11 },
  activity: {
    ...NO_ACTIVITY,
    automations: [
      {
        key: 'digest',
        failing: false,
        automation: {
          id: 'digest',
          name: 'Digest',
          enabled: true,
          nextRunAt: 100,
          updatedAt: 1,
          dtstart: 0,
          rrule: 'FREQ=DAILY',
          workspaceId: null
        }
      }
    ]
  }
}
const bothListed: BotActivityWithAuthority = {
  ...old,
  activity: {
    ...old.activity,
    automations: [
      ...old.activity.automations,
      {
        ...old.activity.automations[0],
        key: 'second',
        automation: { ...old.activity.automations[0].automation, id: 'second', name: 'Second' }
      }
    ]
  }
}
const revision = (pairingRevision: number) => {
  const sample = [{ id: 'paired', createdAt: 1, pairingRevision }]
  replaceRuntimeEnvironmentRevisions(sample)
  return sample
}
let clock = 0

beforeEach(() => {
  clock = 0
  revision(11)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  setRuntimeEnvironmentCatalogRefresher(null)
  clearRuntimeCompatibilityCache()
  replaceRuntimeEnvironmentRevisions([])
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function scenario(
  options: {
    warm?: boolean
    holdActivity?: boolean
    identity?: boolean
    predecessor?: boolean
    pairingRevision?: number
  } = {}
) {
  const oldRevision = options.pairingRevision ?? 11
  const listed: BotActivityWithAuthority = {
    ...bothListed,
    authority: { kind: 'environment', environmentId: 'paired', pairingRevision: oldRevision }
  }
  if (options.warm) {
    markRuntimeEnvironmentCompatible('paired')
  }
  const calls: [string, number | undefined][] = []
  const activityReplies: (() => void)[] = []
  let refused = false
  vi.stubGlobal('api', {
    runtimeEnvironments: {
      call: async ({
        method,
        expectedEnvironmentPairingRevision: expected
      }: {
        method: string
        expectedEnvironmentPairingRevision?: number
      }) => {
        calls.push([method, expected])
        if (
          expected === oldRevision &&
          !(options.predecessor && method === 'bots.activity') &&
          (!options.identity || (!refused && method !== 'bots.activity'))
        ) {
          refused = true
          return runtimeEnvironmentChangedFailure(
            { runtimeId: 'replacement' },
            method,
            !options.identity
          )
        }
        if (method === 'status.get') {
          return { ok: true, result: { runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION } }
        }
        const reply = { ok: true, result: { activity: NO_ACTIVITY } }
        return options.holdActivity
          ? new Promise((resolve) => activityReplies.push(() => resolve(reply)))
          : reply
      }
    }
  })
  const read = createBotHostRead<BotActivityWithAuthority>(
    'bots.activity',
    (result: { activity: typeof NO_ACTIVITY }, authority) => ({
      activity: result.activity,
      authority
    }),
    'read failed',
    ['automations']
  )
  const close = read.subscribe(bot, () => {})
  function openOwner() {
    const { result, unmount } = renderHook(() =>
      useBotAutomationDelete(
        bot,
        {
          read: listed,
          currentRead: () => read.snapshot(botRefKey(bot)) ?? listed,
          refresh: () => read.request(bot),
          refreshSettled: (deadline, canStart) => read.requestSettled(bot, deadline, canStart)
        },
        false
      )
    )
    return {
      unmount,
      admit: async (id = 'digest'): Promise<BotAutomationDeleteAdmission> => {
        const admissions: BotAutomationDeleteAdmission[] = []
        await act(async () => {
          const admission = result.current.admit({
            id,
            name: 'Digest',
            authority: listed.authority,
            botKey: result.current.botKey,
            generation: result.current.generation,
            admittedAsTrouble: false
          })
          if (admission) {
            admissions.push(admission)
          }
        })
        expect(admissions).toHaveLength(1)
        return admissions[0]
      }
    }
  }
  return {
    ...openOwner(),
    openOwner,
    calls,
    close,
    activityReplies,
    request: () => read.request(bot)
  }
}

function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

function watchCatalogSubscribers(): Set<() => void> {
  const subscribers = new Set<() => void>()
  const subscribe = registry.onRuntimeEnvironmentRevisionsPublished
  vi.spyOn(registry, 'onRuntimeEnvironmentRevisionsPublished').mockImplementation((listener) => {
    subscribers.add(listener)
    const dispose = subscribe(listener)
    return () => {
      subscribers.delete(listener)
      dispose()
    }
  })
  return subscribers
}

describe('reconciling a resolved pairing refusal', () => {
  it.each([
    {
      warm: false,
      first: 'status.get',
      followUp: [
        ['status.get', 22],
        ['bots.activity', 22]
      ]
    },
    { warm: true, first: 'automation.delete', followUp: [['bots.activity', 22]] }
  ])(
    'waits for catalog publication before rereading Activity ($first)',
    async ({ warm, first, followUp }) => {
      let publish = (): void => {}
      setRuntimeEnvironmentCatalogRefresher(
        () =>
          new Promise((resolve) => {
            publish = () => {
              resolve(revision(22))
            }
          })
      )
      const view = scenario({ warm })
      const admission = await view.admit()
      expect(view.calls).toEqual([[first, 11]])
      await act(async () => publish())
      // The new host omits the id, but cannot establish what happened on the former host.
      await expect(admission.settled).resolves.toBe('uncertain')
      expect(view.calls).toEqual([[first, 11], ...followUp])
      view.close()
    }
  )

  it('finishes uncertain without an old-revision reread if the catalog fails', async () => {
    let failures = 0
    setRuntimeEnvironmentCatalogRefresher(async () => {
      failures += 1
      throw new Error('catalog unavailable')
    })
    const view = scenario({ warm: true })
    const admission = await view.admit()
    await expect(admission.settled).resolves.toBe('uncertain')
    expect(failures).toBe(1)
    expect(view.calls).toEqual([['automation.delete', 11]])
    view.close()
  })

  it('gives a delayed catalog and a hung Activity one shared deadline', async () => {
    let publish = (): void => {}
    setRuntimeEnvironmentCatalogRefresher(
      () =>
        new Promise((resolve) => {
          publish = () => resolve(revision(22))
        })
    )
    const view = scenario({ warm: true, holdActivity: true })
    const admission = await view.admit()
    expect(view.calls).toEqual([['automation.delete', 11]])
    await act(async () => {
      advance(14_000)
      publish()
    })
    expect(view.calls).toEqual([
      ['automation.delete', 11],
      ['bots.activity', 22]
    ])
    await act(async () => advance(1_000))
    await expect(admission.settled).resolves.toBe('uncertain')
    view.close()
  })

  it('expires while a catalog request is still hung', async () => {
    let finish = (): void => {}
    setRuntimeEnvironmentCatalogRefresher(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([])
        })
    )
    const view = scenario({ warm: true })
    const admission = await view.admit()
    await act(async () => advance(15_000))
    await expect(admission.settled).resolves.toBe('uncertain')
    expect(view.calls).toEqual([['automation.delete', 11]])
    await act(async () => finish())
    view.close()
  })

  it('uses the already-current revision without a catalog refresh', async () => {
    revision(22)
    let catalogs = 0
    setRuntimeEnvironmentCatalogRefresher(async () => {
      catalogs += 1
      return []
    })
    const view = scenario({ warm: true })
    const admission = await view.admit()
    await expect(admission.settled).resolves.toBe('uncertain')
    expect(catalogs).toBe(0)
    expect(view.calls).toEqual([
      ['automation.delete', 11],
      ['bots.activity', 22]
    ])
    view.close()
  })

  it.each([false, true])(
    'releases two recoveries on publication while a shared trailing read stalls (Activity predecessor %s)',
    async (predecessor) => {
      let catalogReads = 0
      let publish = (): void => {}
      let finishTrailing = (): void => {}
      const subscribers = watchCatalogSubscribers()
      setRuntimeEnvironmentCatalogRefresher(
        () =>
          new Promise((resolve) => {
            catalogReads += 1
            if (catalogReads === 1) {
              publish = () => {
                resolve(revision(22))
              }
            } else {
              finishTrailing = () => resolve([])
            }
          })
      )
      const beforeRejection = refreshRuntimeEnvironmentCatalog()
      const view = scenario({ warm: true, holdActivity: true, predecessor })
      if (predecessor) {
        await act(async () => view.request())
      }
      const first = await view.admit()
      const second = await view.admit('second')
      expect(subscribers.size).toBe(2)
      await act(async () => advance(4_000))
      await act(async () => publish())
      await beforeRejection
      expect(catalogReads).toBe(2)
      expect(subscribers.size).toBe(0)
      if (predecessor) {
        expect(view.calls.filter(([method]) => method === 'bots.activity')).toEqual([
          ['bots.activity', 11]
        ])
        await act(async () => view.activityReplies[0]())
      }
      expect(view.calls).toEqual([
        ...(predecessor ? [['bots.activity', 11]] : []),
        ['automation.delete', 11],
        ['automation.delete', 11],
        ['bots.activity', 22]
      ])
      const outcomes: string[] = []
      void first.settled.then((outcome) => outcomes.push(outcome))
      void second.settled.then((outcome) => outcomes.push(outcome))
      await act(async () => advance(10_999))
      expect(outcomes).toEqual([])
      await act(async () => advance(1))
      expect(outcomes).toEqual(['uncertain', 'uncertain'])
      await act(async () => {
        view.activityReplies.at(-1)?.()
        finishTrailing()
      })
      view.close()
    }
  )

  it('requires a post-rejection success when a pre-existing read republishes the same revision', async () => {
    let finishOlder = (): void => {}
    let finishFresh = (): void => {}
    let reads = 0
    setRuntimeEnvironmentCatalogRefresher(
      () =>
        new Promise((resolve) => {
          reads += 1
          if (reads === 1) {
            finishOlder = () => resolve(revision(11))
          } else {
            finishFresh = () => resolve(revision(11))
          }
        })
    )
    const older = refreshRuntimeEnvironmentCatalog()
    const view = scenario({ warm: true, identity: true })
    const admission = await view.admit()
    await act(async () => {
      finishOlder()
    })
    await older
    expect(reads).toBe(2)
    expect(view.calls).toEqual([['automation.delete', 11]])
    await act(async () => {
      finishFresh()
    })
    await expect(admission.settled).resolves.toBe('omitted')
    expect(view.calls).toEqual([
      ['automation.delete', 11],
      ['bots.activity', 11]
    ])
    view.close()
  })

  it('disposes one catalog waiter without cancelling the shared read or the other owner', async () => {
    let publish = (): void => {}
    let catalogReads = 0
    const subscribers = watchCatalogSubscribers()
    const detach = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
    setRuntimeEnvironmentCatalogRefresher(
      () =>
        new Promise((resolve) => {
          catalogReads += 1
          if (catalogReads === 1) {
            publish = () => resolve(revision(22))
          } else {
            resolve([])
          }
        })
    )
    const first = scenario({ warm: true })
    const second = first.openOwner()
    const abandoned = await first.admit()
    const remaining = await second.admit('second')
    expect(subscribers.size).toBe(2)
    const timers = vi.getTimerCount()
    const abortDetaches = () => detach.mock.calls.filter(([event]) => event === 'abort').length
    const beforeDetach = abortDetaches()
    const outcomes: string[] = []
    void abandoned.settled.then((outcome) => outcomes.push(outcome))
    await act(async () => first.unmount())
    expect(outcomes).toEqual(['uncertain'])
    expect(subscribers.size).toBe(1)
    expect(vi.getTimerCount()).toBe(timers - 1)
    expect(abortDetaches()).toBeGreaterThan(beforeDetach)
    expect(catalogReads).toBe(1)
    expect(first.calls).toEqual([
      ['automation.delete', 11],
      ['automation.delete', 11]
    ])
    const beforePublish = abortDetaches()
    await act(async () => publish())
    await expect(remaining.settled).resolves.toBe('uncertain')
    expect(subscribers.size).toBe(0)
    expect(abortDetaches()).toBeGreaterThan(beforePublish)
    expect(first.calls).toEqual([
      ['automation.delete', 11],
      ['automation.delete', 11],
      ['bots.activity', 22]
    ])
    second.unmount()
    first.close()
  })

  it('cannot use an older independent publication as proof after a fresh omission', async () => {
    let publishOlder = (): void => {}
    const older = new Promise<void>((resolve) => {
      publishOlder = resolve
    }).then(() => revision(11))
    setRuntimeEnvironmentCatalogRefresher(async () => {
      replaceRuntimeEnvironmentRevisions([])
      publishOlder()
      return []
    })
    const view = scenario({ warm: true, identity: true })
    const admission = await view.admit()
    await older
    expect(registry.getRuntimeEnvironmentRevision('paired')).toBe(11)
    await expect(admission.settled).resolves.toBe('uncertain')
    expect(view.calls).toEqual([['automation.delete', 11]])
    view.close()
  })

  it.each([false, true])(
    'rechecks sampled authority after an Activity predecessor (independent read %s)',
    async (independent) => {
      setRuntimeEnvironmentCatalogRefresher(async () => revision(11))
      const view = scenario({ warm: true, identity: true, predecessor: true, holdActivity: true })
      await act(async () => view.request())
      const admission = await view.admit()
      const outcomes: string[] = []
      void admission.settled.then((outcome) => outcomes.push(outcome))
      expect(view.calls).toEqual([
        ['bots.activity', 11],
        ['automation.delete', 11]
      ])
      await act(async () => {
        revision(22)
        if (independent) {
          view.request()
        }
        view.activityReplies[0]()
      })
      expect(outcomes).toEqual(['uncertain'])
      expect(view.calls).toEqual([
        ['bots.activity', 11],
        ['automation.delete', 11],
        ...(independent ? [['bots.activity', 22]] : [])
      ])
      await act(async () => view.activityReplies[1]?.())
      view.close()
    }
  )

  it('preserves zero as a sampled same revision', async () => {
    revision(0)
    setRuntimeEnvironmentCatalogRefresher(async () => revision(0))
    const view = scenario({ warm: true, identity: true, pairingRevision: 0 })
    const admission = await view.admit()
    await expect(admission.settled).resolves.toBe('omitted')
    expect(view.calls).toEqual([
      ['automation.delete', 0],
      ['bots.activity', 0]
    ])
    view.close()
  })

  it.each([false, true])(
    'uses a successful fresh catalog to reconcile a same-revision identity refusal (warm %s)',
    async (warm) => {
      let reads = 0
      setRuntimeEnvironmentCatalogRefresher(async () => {
        reads += 1
        return revision(11)
      })
      const view = scenario({ warm, identity: true })
      const admission = await view.admit()
      await expect(admission.settled).resolves.toBe('omitted')
      expect(reads).toBe(1)
      expect(view.calls).toEqual(
        warm
          ? [
              ['automation.delete', 11],
              ['bots.activity', 11]
            ]
          : [
              ['status.get', 11],
              ['status.get', 11],
              ['bots.activity', 11]
            ]
      )
      view.close()
    }
  )

  it.each(['failed', 'unavailable', 'timeout', 'removed'] as const)(
    'does not read the same revision after an identity refusal with a %s catalog',
    async (kind) => {
      const subscribers = watchCatalogSubscribers()
      let release = (): void => {}
      if (kind !== 'unavailable') {
        setRuntimeEnvironmentCatalogRefresher(async () => {
          if (kind === 'failed') {
            throw new Error('catalog unavailable')
          }
          if (kind === 'removed') {
            replaceRuntimeEnvironmentRevisions([])
          }
          if (kind === 'timeout') {
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          return []
        })
      }
      const view = scenario({ warm: true, identity: true })
      const admission = await view.admit()
      const outcomes: string[] = []
      void admission.settled.then((outcome) => outcomes.push(outcome))
      if (kind === 'timeout') {
        expect(subscribers.size).toBe(1)
        await act(async () => advance(14_999))
        expect(outcomes).toEqual([])
        await act(async () => advance(1))
        expect(outcomes).toEqual(['uncertain'])
      }
      await expect(admission.settled).resolves.toBe('uncertain')
      expect(subscribers.size).toBe(0)
      expect(view.calls).toEqual([['automation.delete', 11]])
      await act(async () => {
        revision(22)
        release()
      })
      expect(view.calls).toEqual([['automation.delete', 11]])
      view.close()
    }
  )
})
