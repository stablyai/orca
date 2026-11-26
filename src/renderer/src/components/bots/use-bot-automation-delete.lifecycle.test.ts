// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotRef } from '@/lib/bot-hosts'
import type {
  BotAutomationDeleteAdmission,
  BotAutomationDeleteIntent
} from './use-bot-automation-delete'
import { useBotAutomationDelete } from './use-bot-automation-delete'
import { NO_ACTIVITY, type BotActivityWithAuthority } from './use-bot-activity'

const localRead: BotActivityWithAuthority = {
  authority: { kind: 'local' },
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

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps a delete intent and its completion within the bot visit that created it', async () => {
  const local: BotRef = { hostId: 'local', id: 'b1' }
  const paired: BotRef = { hostId: 'runtime:paired', id: 'b1' }
  const replies: (() => void)[] = []
  vi.stubGlobal('api', {
    runtime: {
      call: () => new Promise((resolve) => replies.push(() => resolve({ ok: true, result: {} })))
    }
  })
  const activity = {
    read: localRead,
    currentRead: () => localRead,
    refresh: () => {},
    refreshSettled: async () => ({ ok: false as const })
  }
  const { result, rerender } = renderHook((bot) => useBotAutomationDelete(bot, activity, false), {
    initialProps: local
  })
  const intent = (): BotAutomationDeleteIntent => ({
    id: 'digest',
    name: 'Digest',
    authority: { kind: 'local' },
    botKey: result.current.botKey,
    generation: result.current.generation,
    admittedAsTrouble: false
  })
  const old = intent()
  act(() => {
    expect(result.current.admit(old)).not.toBeNull()
  })
  rerender(paired)
  rerender(local)
  act(() => {
    expect(result.current.admit(old)).toBeNull()
  })
  const admissions: BotAutomationDeleteAdmission[] = []
  act(() => {
    const current = result.current.admit(intent())
    if (current) {
      admissions.push(current)
    }
  })
  expect(admissions).toHaveLength(1)
  expect(replies).toHaveLength(2)
  await act(async () => replies[0]())
  expect(result.current.pending.get('digest')?.opId).toBe(admissions[0].opId)
})

it('declines a stale intent when the newest raw read classifies the same id as a wait', async () => {
  const bot: BotRef = { hostId: 'local', id: 'b1' }
  let deletes = 0
  let currentRead = localRead
  vi.stubGlobal('api', {
    runtime: {
      call: async () => {
        deletes += 1
        return { ok: true, result: {} }
      }
    }
  })
  const { result } = renderHook(() =>
    useBotAutomationDelete(
      bot,
      {
        read: localRead,
        currentRead: () => currentRead,
        refresh: () => {},
        refreshSettled: async () => ({ ok: false })
      },
      false
    )
  )
  const intent: BotAutomationDeleteIntent = {
    id: 'digest',
    name: 'Digest',
    authority: localRead.authority,
    botKey: result.current.botKey,
    generation: result.current.generation,
    admittedAsTrouble: false
  }
  currentRead = {
    ...localRead,
    activity: { ...NO_ACTIVITY, waits: localRead.activity.automations }
  }
  act(() => {
    expect(result.current.admit(intent)).toBeNull()
  })
  expect(deletes).toBe(0)
  currentRead = localRead
  await act(async () => {
    const accepted = result.current.admit(intent)
    expect(accepted).not.toBeNull()
    await expect(accepted?.settled).resolves.toBe('hidden')
  })
  expect(deletes).toBe(1)
})

it('refuses a row read while its pairing was unknown: no admission, delete or recovery read', () => {
  const bot: BotRef = { hostId: 'runtime:paired', id: 'b1' }
  const unavailable: BotActivityWithAuthority = {
    ...localRead,
    authority: { kind: 'environment-unavailable', environmentId: 'paired' }
  }
  let rpcs = 0
  let recoveries = 0
  vi.stubGlobal('api', {
    runtime: {
      call: async () => {
        rpcs += 1
        return { ok: true, result: {} }
      }
    },
    runtimeEnvironments: {
      call: async () => {
        rpcs += 1
        return { ok: true, result: {} }
      }
    }
  })
  const { result } = renderHook(() =>
    useBotAutomationDelete(
      bot,
      {
        read: unavailable,
        currentRead: () => unavailable,
        refresh: () => {},
        refreshSettled: async () => {
          recoveries += 1
          return { ok: false }
        }
      },
      false
    )
  )
  const intent: BotAutomationDeleteIntent = {
    id: 'digest',
    name: 'Digest',
    authority: unavailable.authority,
    botKey: result.current.botKey,
    generation: result.current.generation,
    admittedAsTrouble: false
  }
  expect(result.current.membership(intent)).toBe('listed')
  expect(result.current.canAdmit(intent)).toBe(false)
  act(() => {
    expect(result.current.admit(intent)).toBeNull()
  })
  expect(result.current.pending.size).toBe(0)
  expect(rpcs).toBe(0)
  expect(recoveries).toBe(0)
})
