// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { patchLookAround, type BotLookAround } from '../../../../../shared/bots/bot-look-around'
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

function editor() {
  let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
  const bot = { ...base, lookAround: saved }
  const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
    saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
    return { ...bot, lookAround: saved }
  })
  const view = renderHook(() =>
    useLookAroundEdit(
      bot,
      update,
      {
        setting: bot.lookAround,
        upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
      },
      null
    )
  )
  return { view, saved: () => saved }
}

beforeEach(() => probe.mockReset().mockResolvedValue(true))
afterEach(cleanup)

it.each<[string, boolean, boolean]>([
  ['zone then preset', false, false],
  ['zone then preset', true, false],
  ['zone then preset', false, true],
  ['zone then preset', true, true],
  ['Custom then zone', false, false],
  ['Custom then zone', true, false],
  ['Custom then zone', false, true],
  ['Custom then zone', true, true]
])(
  'preserves independent %s edits (reverse completion=%s, close first=%s)',
  async (order, reverse, close) => {
    const first = deferred()
    const second = deferred()
    probe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const e = editor()
    act(() => {
      if (order === 'zone then preset') {
        e.view.result.current.change({ timezone: 'America/Los_Angeles' })
        e.view.result.current.change({ every: 'mornings' })
      } else {
        e.view.result.current.change({ every: 'custom' })
        e.view.result.current.change({ timezone: 'America/Los_Angeles' })
      }
    })
    if (close) {
      e.view.unmount()
    }
    await act(async () => (reverse ? second : first).resolve(true))
    await act(async () => (reverse ? first : second).resolve(true))
    if (order === 'zone then preset') {
      expect(e.saved()).toMatchObject({ every: 'mornings', timezone: 'America/Los_Angeles' })
    } else {
      expect(e.saved()).toMatchObject({ every: 'custom', timezone: 'America/Los_Angeles' })
    }
  }
)

it.each<[string | null, string | null, string]>([
  ['America/Los_Angeles', 'Asia/Tokyo', 'Asia/Tokyo'],
  ['America/Los_Angeles', null, 'host'],
  [null, 'America/Los_Angeles', 'America/Los_Angeles']
])('keeps the newer zone choice from %s to %s', async (firstZone, secondZone, expected) => {
  const first = deferred()
  const second = deferred()
  probe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const e = editor()
  act(() => e.view.result.current.change({ timezone: firstZone }))
  act(() => e.view.result.current.change({ timezone: secondZone }))
  await act(async () => second.resolve(true))
  await act(async () => first.resolve(true))
  expect(e.saved().timezone).toBe(expected)
})

it('preserves newer on, weekday and focus choices from a pending multi-field Custom edit', async () => {
  const first = deferred()
  probe.mockReturnValueOnce(first.promise)
  const e = editor()
  act(() =>
    e.view.result.current.change({
      times: ['07:30', '14:00'],
      on: true,
      weekdaysOnly: true,
      focus: 'old focus'
    })
  )
  act(() => e.view.result.current.change({ on: false }))
  act(() => e.view.result.current.change({ weekdaysOnly: false }))
  act(() => e.view.result.current.change({ focus: 'new focus' }))
  await act(async () => first.resolve(true))
  expect(e.saved()).toMatchObject({
    every: 'custom',
    times: ['07:30', '14:00'],
    timezone: 'UTC',
    on: false,
    weekdaysOnly: false,
    focus: 'new focus'
  })
})

it('does not revive an older zone when the newer zone preflight fails', async () => {
  const first = deferred()
  const second = deferred()
  probe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const e = editor()
  act(() => e.view.result.current.change({ timezone: 'America/Los_Angeles' }))
  act(() => e.view.result.current.change({ timezone: 'Asia/Tokyo' }))
  await act(async () => second.resolve(false))
  await act(async () => first.resolve(true))
  expect(e.saved().timezone).toBe('UTC')
})

it('releases a newer unzoned preset after the independent pending zone commits', async () => {
  const first = deferred()
  probe.mockReturnValueOnce(first.promise)
  let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h', timezone: undefined }
  const view = renderHook(() => {
    const [bot, setBot] = useState({ ...base, lookAround: saved })
    const update = async ({ lookAround }: BotUpdateParams['updates']) => {
      saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
      const updated = { ...bot, lookAround: saved }
      setBot(updated)
      return updated
    }
    return useLookAroundEdit(
      bot,
      update,
      {
        setting: bot.lookAround,
        upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
      },
      null
    )
  })
  act(() => view.result.current.change({ every: 'custom' }))
  act(() => view.result.current.answerZone('UTC'))
  act(() => view.result.current.change({ every: 'mornings' }))
  await act(async () => first.resolve(true))
  expect(saved).toMatchObject({ every: 'mornings', timezone: 'UTC' })
})
