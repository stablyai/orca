// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { botRefKey, type BotRef } from '@/lib/bot-hosts'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { setRuntimeEnvironmentCatalogRefresher } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
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
const revision = (pairingRevision: number): void => {
  replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 1, pairingRevision }])
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

function scenario(options: { warm?: boolean; holdActivity?: boolean } = {}) {
  if (options.warm) {
    markRuntimeEnvironmentCompatible('paired')
  }
  const calls: [string, number | undefined][] = []
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
        if (expected !== 22) {
          return runtimeEnvironmentChangedFailure({ runtimeId: 'replacement' }, method, true)
        }
        if (method === 'status.get') {
          return { ok: true, result: { runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION } }
        }
        return options.holdActivity
          ? new Promise(() => {})
          : { ok: true, result: { activity: NO_ACTIVITY } }
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
  const { result } = renderHook(() =>
    useBotAutomationDelete(
      bot,
      {
        read: old,
        currentRead: () => read.snapshot(botRefKey(bot)) ?? old,
        refresh: () => read.request(bot),
        refreshSettled: (deadline) => read.requestSettled(bot, deadline)
      },
      false
    )
  )
  return {
    calls,
    close,
    admit: async (): Promise<BotAutomationDeleteAdmission> => {
      const admissions: BotAutomationDeleteAdmission[] = []
      await act(async () => {
        const admission = result.current.admit({
          id: 'digest',
          name: 'Digest',
          authority: old.authority,
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

function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
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
              revision(22)
              resolve()
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
    setRuntimeEnvironmentCatalogRefresher(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            revision(22)
            resolve()
          }, 14_000)
        })
    )
    const view = scenario({ warm: true, holdActivity: true })
    const admission = await view.admit()
    expect(view.calls).toEqual([['automation.delete', 11]])
    await act(async () => advance(14_000))
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
          finish = resolve
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
})
