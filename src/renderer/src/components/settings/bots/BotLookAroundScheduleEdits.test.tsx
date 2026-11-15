// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { patchLookAround, type BotLookAround } from '../../../../../shared/bots/bot-look-around'
import type * as LookAroundCopy from '@/components/bots/bot-look-around-copy'
import type { LookAroundStatus } from '@/components/bots/use-look-around-status'

const mocks = vi.hoisted(
  (): {
    status: LookAroundStatus | null
    error: unknown
    probe: Mock<() => Promise<boolean>>
    refresh: Mock
  } => ({
    status: null,
    error: null,
    probe: vi.fn(async () => true),
    refresh: vi.fn()
  })
)
vi.mock('@/components/bots/use-look-around-status', () => ({
  useLookAroundStatus: () => mocks.status,
  useLookAroundReadError: () => mocks.error,
  useLookAroundFailing: () => 0,
  lookAroundHostTakesCustom: mocks.probe,
  refreshLookAroundStatus: mocks.refresh
}))
vi.mock('./BotLookAroundStatus', () => ({ BotLookAroundStatus: () => null }))
vi.mock('@/components/bots/bot-presentation', () => ({ botAgentLabel: () => 'Claude Code' }))
vi.mock('@/components/bots/use-bot-activity', () => ({ useBotActivity: () => ({}) }))
vi.mock('@/components/bots/use-bot-host-label', () => ({ useBotHostLabel: () => 'Server' }))
vi.mock('@/components/bots/bot-look-around-copy', async (original) => ({
  ...(await original<typeof LookAroundCopy>()),
  viewerTimeZone: () => 'America/Los_Angeles'
}))
vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange
  }: {
    children: ReactNode
    value: string
    onValueChange: (value: string) => void
  }) => (
    <select aria-label="How often" value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectSeparator: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  )
}))

import { BotLookAroundSection } from './BotLookAroundSection'
import { lookAroundEditorBot as base } from './look-around-editor.test-fixture'

function deferred() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  mocks.status = {
    setting: base.lookAround!,
    upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
  }
  mocks.error = null
  mocks.probe.mockReset().mockResolvedValue(true)
})
afterEach(cleanup)

describe('Look around schedule edits', () => {
  it.each(['pending', 'failed'])(
    'holds an unzoned preset while the host clock is %s, then asks before saving',
    async (read) => {
      mocks.status = null
      mocks.error = read === 'failed' ? new Error('offline') : null
      const bot = { ...base, lookAround: { ...base.lookAround!, timezone: undefined } }
      const update = vi.fn(async () => null)
      const view = render(<BotLookAroundSection bot={bot} update={update} />)
      fireEvent.change(screen.getByRole('combobox', { name: 'How often' }), {
        target: { value: 'mornings' }
      })
      expect(update).not.toHaveBeenCalled()
      mocks.status = {
        setting: bot.lookAround,
        upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
      }
      mocks.error = null
      view.rerender(<BotLookAroundSection bot={bot} update={update} />)
      expect(update).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /Server/ }))
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith({
          lookAround: { every: 'mornings', timezone: 'UTC', editorTimeZone: 'America/Los_Angeles' }
        })
      )
    }
  )

  it('saves a held preset once a same-zone clock succeeds', async () => {
    mocks.status = null
    const bot = { ...base, lookAround: { ...base.lookAround!, timezone: undefined } }
    const update = vi.fn(async () => null)
    const view = render(<BotLookAroundSection bot={bot} update={update} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mornings' } })
    expect(update).not.toHaveBeenCalled()
    mocks.status = {
      setting: bot.lookAround,
      upNext: { running: false, seenAt: 0, hostTimeZone: 'America/Los_Angeles' }
    }
    view.rerender(<BotLookAroundSection bot={bot} update={update} />)
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        lookAround: { every: 'mornings', editorTimeZone: 'America/Los_Angeles' }
      })
    )
  })

  it('allows preset fallback only for a definitive old host', () => {
    mocks.status = null
    mocks.error = Object.assign(new Error('old'), { code: 'method_not_found' })
    const bot = { ...base, lookAround: { ...base.lookAround!, timezone: undefined } }
    const update = vi.fn(async () => null)
    render(<BotLookAroundSection bot={bot} update={update} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mornings' } })
    expect(update).toHaveBeenCalledWith({
      lookAround: { every: 'mornings', editorTimeZone: 'America/Los_Angeles' }
    })
  })

  it('keeps the newer preset when an older custom preflight finishes later, including on close', async () => {
    const first = deferred()
    mocks.probe.mockReturnValueOnce(first.promise)
    let saved = base.lookAround!
    const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
      saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
      return null
    })
    const view = render(<BotLookAroundSection bot={base} update={update} />)
    const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
    fireEvent.change(hour, { target: { value: '07' } })
    fireEvent.blur(hour)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mornings' } })
    await act(async () => first.resolve(true))
    view.unmount()
    await act(async () => {})
    expect(saved).toMatchObject({ every: 'mornings', times: ['09:30', '14:00'] })
  })

  it('keeps newer custom times when preflights finish in reverse order', async () => {
    const first = deferred()
    const second = deferred()
    mocks.probe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    let saved = base.lookAround!
    const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
      saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
      return null
    })
    render(<BotLookAroundSection bot={base} update={update} />)
    const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
    fireEvent.change(hour, { target: { value: '07' } })
    fireEvent.blur(hour)
    fireEvent.change(hour, { target: { value: '06' } })
    fireEvent.blur(hour)
    await act(async () => second.resolve(true))
    await act(async () => first.resolve(true))
    expect(saved).toMatchObject({ every: 'custom', times: ['06:30', '14:00'] })
  })

  it.each<[string, string, string[]]>([
    ['Hour', '7', ['07:30', '14:00']],
    ['Hour', '07', ['07:30', '14:00']],
    ['Minute', '5', ['09:05', '14:00']],
    ['Minute', '05', ['09:05', '14:00']]
  ])(
    'saves %s %s on list exit and preserves its committed draft on settings close',
    async (label, digits, expected) => {
      const update = vi.fn(async () => null)
      const view = render(<BotLookAroundSection bot={base} update={update} />)
      const field = screen.getAllByRole('textbox', { name: label })[0]!
      fireEvent.focus(field)
      fireEvent.change(field, { target: { value: digits } })
      fireEvent.blur(field, { relatedTarget: screen.getByRole('textbox', { name: 'Look for' }) })
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith({
          lookAround: { times: expected, editorTimeZone: 'America/Los_Angeles' }
        })
      )
      update.mockClear()
      view.unmount()
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith({
          lookAround: { times: expected, editorTimeZone: 'America/Los_Angeles' }
        })
      )
    }
  )
})

it('keeps pending Custom and zone selections after Settings actually unmounts', async () => {
  const custom = deferred()
  const zone = deferred()
  mocks.probe.mockReturnValueOnce(custom.promise).mockReturnValueOnce(zone.promise)
  let saved: BotLookAround = { ...base.lookAround!, every: 'every-4h' }
  const bot = { ...base, lookAround: saved }
  const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
    saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
    return { ...bot, lookAround: saved }
  })
  const view = render(<BotLookAroundSection bot={bot} update={update} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } })
  fireEvent.click(screen.getByRole('button', { name: 'Change' }))
  fireEvent.change(screen.getAllByRole('combobox')[1]!, {
    target: { value: 'America/Los_Angeles' }
  })
  view.unmount()
  await act(async () => zone.resolve(true))
  await act(async () => custom.resolve(true))
  expect(saved).toMatchObject({ every: 'custom', timezone: 'America/Los_Angeles' })
})
