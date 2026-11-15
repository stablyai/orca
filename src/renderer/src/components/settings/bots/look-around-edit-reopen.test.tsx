// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { patchLookAround, type BotLookAround } from '../../../../../shared/bots/bot-look-around'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { lookAroundEditorBot as base } from './look-around-editor.test-fixture'

const probe = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/components/bots/use-look-around-status', () => ({
  lookAroundHostTakesCustom: probe,
  refreshLookAroundStatus: vi.fn()
}))
vi.mock('@/components/bots/bot-look-around-copy', () => ({
  viewerTimeZone: () => 'America/Los_Angeles'
}))
import { useLookAroundEdit } from './use-look-around-edit'

function deferred() {
  let resolve!: (ok: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => probe.mockReset().mockResolvedValue(true))
afterEach(cleanup)

it.each<[string, string, string, string]>([
  ['Custom', 'preset', 'mornings', 'UTC'],
  ['zone', 'zone', 'every-4h', 'Asia/Tokyo'],
  ['zone', 'preset', 'mornings', 'America/Los_Angeles'],
  ['Custom', 'zone', 'custom', 'Asia/Tokyo']
])(
  'orders a pending %s across close/reopen before a newer %s',
  async (older, newer, every, timezone) => {
    const first = deferred()
    probe.mockReturnValueOnce(first.promise)
    let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
    const update = async ({ lookAround }: BotUpdateParams['updates']) => {
      saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
      return { ...base, lookAround: saved }
    }
    const renderEditor = () =>
      renderHook(() =>
        useLookAroundEdit(
          { ...base, lookAround: saved },
          update,
          {
            setting: saved,
            upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
          },
          null
        )
      )
    const old = renderEditor()
    act(() =>
      old.result.current.change(
        older === 'Custom' ? { every: 'custom' } : { timezone: 'America/Los_Angeles' }
      )
    )
    old.unmount()
    const reopened = renderEditor()
    await act(async () =>
      reopened.result.current.change(
        newer === 'preset' ? { every: 'mornings' } : { timezone: 'Asia/Tokyo' }
      )
    )
    await act(async () => first.resolve(true))
    expect(saved).toMatchObject({ every, timezone })
  }
)

it('keeps another bot independent while an editor is closed with a preflight pending', async () => {
  const first = deferred()
  probe.mockReturnValueOnce(first.promise)
  let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
  const old = renderHook(() =>
    useLookAroundEdit(
      base,
      async ({ lookAround }) => {
        saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
        return { ...base, lookAround: saved }
      },
      { setting: saved, upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' } },
      null
    )
  )
  act(() => old.result.current.change({ every: 'custom' }))
  old.unmount()
  const other = renderHook(() =>
    useLookAroundEdit(
      { ...base, id: 'other' },
      async () => null,
      {
        setting: base.lookAround!,
        upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
      },
      null
    )
  )
  act(() => other.result.current.change({ every: 'mornings' }))
  await act(async () => first.resolve(true))
  expect(saved.every).toBe('custom')
})

it('keeps the same bot id on another host independent of a closed pending editor', async () => {
  const first = deferred()
  probe.mockReturnValueOnce(first.promise)
  let local: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
  let remote: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
  const old = renderHook(() =>
    useLookAroundEdit(
      base,
      async ({ lookAround }) => {
        local = patchLookAround(local, lookAround ?? {}, 0, 'UTC')
        return { ...base, lookAround: local }
      },
      { setting: local, upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' } },
      null
    )
  )
  act(() => old.result.current.change({ every: 'custom' }))
  old.unmount()
  const otherBot = stampBotHost('runtime:independent', { ...base })
  const other = renderHook(() =>
    useLookAroundEdit(
      otherBot,
      async ({ lookAround }) => {
        remote = patchLookAround(remote, lookAround ?? {}, 0, 'UTC')
        return { ...otherBot, lookAround: remote }
      },
      { setting: remote, upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' } },
      null
    )
  )
  act(() => other.result.current.change({ every: 'mornings' }))
  await act(async () => first.resolve(true))
  expect(local.every).toBe('custom')
  expect(remote.every).toBe('mornings')
})

it.each<[boolean, string]>([
  [true, 'America/Los_Angeles'],
  [false, 'UTC']
])(
  'keeps older pending work ordered through a second reopen (middle preflight=%s)',
  async (middleOk, timezone) => {
    const first = deferred()
    const middle = deferred()
    probe.mockReturnValueOnce(first.promise).mockReturnValueOnce(middle.promise)
    let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
    const update = async ({ lookAround }: BotUpdateParams['updates']) => {
      saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
      return { ...base, lookAround: saved }
    }
    const open = () =>
      renderHook(() =>
        useLookAroundEdit(
          { ...base, lookAround: saved },
          update,
          {
            setting: saved,
            upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
          },
          null
        )
      )
    const old = open()
    act(() => old.result.current.change({ every: 'custom' }))
    old.unmount()
    const second = open()
    act(() => second.result.current.change({ timezone: 'America/Los_Angeles' }))
    second.unmount()
    await act(async () => middle.resolve(middleOk))
    const third = open()
    act(() => third.result.current.change({ every: 'mornings' }))
    await act(async () => first.resolve(true))
    expect(saved).toMatchObject({ every: 'mornings', timezone })
  }
)
