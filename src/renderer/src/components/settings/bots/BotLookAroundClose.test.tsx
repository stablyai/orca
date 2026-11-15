// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { patchLookAround } from '../../../../../shared/bots/bot-look-around'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
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

function ClosingSettings({
  update
}: {
  update: (updates: BotUpdateParams['updates']) => Promise<null>
}) {
  const [open, setOpen] = useState(true)
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false)
        }
      }}
    >
      <button onClick={() => setOpen(false)}>Back</button>
      {open ? <BotLookAroundSection bot={base} update={update} /> : null}
    </div>
  )
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

it.each<[string, string, string, string[]]>([
  ['Hour', '7', 'unmount', ['07:30', '14:00']],
  ['Minute', '5', 'unmount', ['09:05', '14:00']],
  ['Hour', '7', 'Escape', ['07:30', '14:00']],
  ['Minute', '5', 'Escape', ['09:05', '14:00']],
  ['Hour', '7', 'Back', ['07:30', '14:00']],
  ['Minute', '5', 'Back', ['09:05', '14:00']],
  ['Hour', '07', 'unmount', ['07:30', '14:00']],
  ['Minute', '05', 'unmount', ['09:05', '14:00']],
  ['Hour', '', 'unmount', ['01:30', '14:00']],
  ['Minute', '', 'unmount', ['09:00', '14:00']]
])(
  'saves raw %s %s when Settings closes by %s without blur',
  async (label, digits, how, expected) => {
    const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
    const view = render(<ClosingSettings update={update} />)
    const field = screen.getAllByRole('textbox', { name: label })[0]!
    fireEvent.focus(field)
    fireEvent.change(field, { target: { value: digits } })
    if (how === 'Escape') {
      fireEvent.keyDown(field, { key: 'Escape' })
    } else if (how === 'Back') {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    } else {
      view.unmount()
    }
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        lookAround: { times: expected, editorTimeZone: 'America/Los_Angeles' }
      })
    )
  }
)

it('keeps a raw hour when AM/PM commits it before close', async () => {
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  const view = render(<ClosingSettings update={update} />)
  const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
  fireEvent.focus(hour)
  fireEvent.change(hour, { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: 'AM or PM: AM' }))
  view.unmount()
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      lookAround: { times: ['19:30', '14:00'], editorTimeZone: 'America/Los_Angeles' }
    })
  )
})

it('retains the newer preset instead of replaying raw Custom input on close', async () => {
  let saved = base.lookAround!
  const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
    saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
    return null
  })
  const view = render(<ClosingSettings update={update} />)
  const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
  fireEvent.focus(hour)
  fireEvent.change(hour, { target: { value: '7' } })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mornings' } })
  view.unmount()
  await act(async () => {})
  expect(saved).toMatchObject({ every: 'mornings', times: ['09:30', '14:00'] })
})

it('leaves saved times when a raw minute makes the list invalid', async () => {
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  const bot = { ...base, lookAround: { ...base.lookAround!, times: ['09:30', '10:30'] } }
  const view = render(<BotLookAroundSection bot={bot} update={update} />)
  const minute = screen.getAllByRole('textbox', { name: 'Minute' })[1]!
  fireEvent.focus(minute)
  fireEvent.change(minute, { target: { value: '5' } })
  view.unmount()
  await Promise.resolve()
  expect(update).not.toHaveBeenCalled()
})

it('keeps an unzoned raw draft unsaved when closing before the host clock answers', async () => {
  mocks.status = null
  const bot = { ...base, lookAround: { ...base.lookAround!, timezone: undefined } }
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  const view = render(<BotLookAroundSection bot={bot} update={update} />)
  const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
  fireEvent.focus(hour)
  fireEvent.change(hour, { target: { value: '7' } })
  view.unmount()
  await Promise.resolve()
  expect(update).not.toHaveBeenCalled()
})

it('saves Look for without requiring a blur before close', async () => {
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  render(<ClosingSettings update={update} />)
  const field = screen.getByRole('textbox', { name: 'Look for' })
  fireEvent.change(field, { target: { value: 'CI on main' } })
  fireEvent.keyDown(field, { key: 'Escape' })
  await waitFor(() => expect(update).toHaveBeenCalledWith({ lookAround: { focus: 'CI on main' } }))
})

it.each<[string, string[]]>([
  ['add', ['07:30', '14:00', '15:00']],
  ['remove other', ['07:30']],
  ['remove edited', ['14:00']]
])('keeps the intended raw list when %s happens before a blur', async (action, expected) => {
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  const view = render(<ClosingSettings update={update} />)
  const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
  fireEvent.focus(hour)
  fireEvent.change(hour, { target: { value: '7' } })
  if (action === 'add') {
    fireEvent.click(screen.getByRole('button', { name: '+ Add time' }))
  } else {
    fireEvent.click(
      screen.getAllByRole('button', { name: /^Remove / })[action === 'remove other' ? 1 : 0]!
    )
  }
  view.unmount()
  await waitFor(() =>
    expect(update).toHaveBeenLastCalledWith({
      lookAround: { times: expected, editorTimeZone: 'America/Los_Angeles' }
    })
  )
})

it('steps from the raw minute and saves that choice on close', async () => {
  const update = vi.fn(async (_updates: BotUpdateParams['updates']) => null)
  const view = render(<ClosingSettings update={update} />)
  const minute = screen.getAllByRole('textbox', { name: 'Minute' })[0]!
  fireEvent.focus(minute)
  fireEvent.change(minute, { target: { value: '5' } })
  fireEvent.keyDown(minute, { key: 'ArrowDown' })
  view.unmount()
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      lookAround: { times: ['09:04', '14:00'], editorTimeZone: 'America/Los_Angeles' }
    })
  )
})

it.each([false, true])(
  'retains raw times when Look around is toggled off (reopen=%s)',
  async (reopen) => {
    let saved = base.lookAround!
    function LiveSettings() {
      const [bot, setBot] = useState(base)
      const update = async ({ lookAround }: BotUpdateParams['updates']) => {
        saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
        const updated = { ...bot, lookAround: saved }
        setBot(updated)
        return updated
      }
      return <BotLookAroundSection bot={bot} update={update} />
    }
    const view = render(<LiveSettings />)
    const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
    fireEvent.focus(hour)
    fireEvent.change(hour, { target: { value: '7' } })
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Look around' })))
    if (reopen) {
      await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Look around' })))
      expect(screen.getAllByRole('textbox', { name: 'Hour' })[0]).toHaveProperty('value', '7')
    }
    view.unmount()
    await waitFor(() => expect(saved).toMatchObject({ times: ['07:30', '14:00'], on: reopen }))
  }
)
