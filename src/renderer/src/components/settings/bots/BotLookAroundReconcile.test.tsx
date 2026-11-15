// @vitest-environment happy-dom
// Review findings CS-C4-1 (an acknowledged Custom draft must not overwrite a newer saved schedule on
// close) and CS-C4-2 (a schedule edit made while a zone choice is pending must survive close).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { patchLookAround, type BotLookAround } from '../../../../../shared/bots/bot-look-around'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import type * as LookAroundCopy from '@/components/bots/bot-look-around-copy'
import type { LookAroundStatus } from '@/components/bots/use-look-around-status'

const mocks = vi.hoisted(
  (): {
    status: LookAroundStatus | null
    probe: Mock<() => Promise<boolean>>
  } => ({
    status: null,
    probe: vi.fn(async () => true)
  })
)
vi.mock('@/components/bots/use-look-around-status', () => ({
  useLookAroundStatus: () => mocks.status,
  useLookAroundReadError: () => null,
  useLookAroundFailing: () => 0,
  lookAroundHostTakesCustom: mocks.probe,
  refreshLookAroundStatus: vi.fn()
}))
vi.mock('./BotLookAroundStatus', () => ({
  BotLookAroundStatus: ({ unsaved }: { unsaved: boolean }) => (
    <p>{unsaved ? 'Not saved' : 'Saved'}</p>
  )
}))
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
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
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

/** Settings bound to a live saved bot: our saves and saves from elsewhere both reach the editor. */
function live(initial: BotLookAround) {
  let saved = initial
  let push: (next: BotLookAround) => void = () => {}
  const update = vi.fn(async ({ lookAround }: BotUpdateParams['updates']) => {
    saved = patchLookAround(saved, lookAround ?? {}, 0, 'UTC')
    push(saved)
    return null
  })
  function Settings(): React.JSX.Element | null {
    const [bot, setBot] = useState<Bot>({ ...base, lookAround: initial })
    const [open, setOpen] = useState(true)
    push = (next) => setBot((current) => ({ ...current, lookAround: next }))
    return (
      <>
        <button onClick={() => setOpen(false)}>Back</button>
        {open ? <BotLookAroundSection bot={bot} update={update} /> : null}
      </>
    )
  }
  return {
    update,
    saved: () => saved,
    render: () => render(<Settings />),
    /** A save from elsewhere (the bot, another client). */
    external: (next: Partial<BotLookAround>) =>
      act(() => {
        saved = { ...saved, ...next }
        push(saved)
      }),
    close: () => act(() => fireEvent.click(screen.getByRole('button', { name: 'Back' })))
  }
}

beforeEach(() => {
  mocks.status = {
    setting: base.lookAround!,
    upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' }
  }
  mocks.probe.mockReset().mockResolvedValue(true)
})
afterEach(cleanup)

it.each<[string, boolean, boolean]>([
  ['after an acknowledged edit, closing', true, true],
  ['after an acknowledged edit, staying open', true, false],
  ['with no prior edit, closing', false, true]
])('CS-C4-1: a newer saved schedule wins %s Settings', async (_name, edit, close) => {
  const settings = live(base.lookAround!)
  settings.render()
  if (edit) {
    const hour = screen.getAllByRole('textbox', { name: 'Hour' })[0]!
    fireEvent.focus(hour)
    fireEvent.change(hour, { target: { value: '07' } })
    await act(async () => fireEvent.blur(hour))
    expect(settings.saved().times).toEqual(['07:30', '14:00'])
  }
  settings.external({ times: ['10:00', '16:00'] })
  expect(screen.getAllByRole('textbox', { name: 'Hour' })[0]).toHaveProperty('value', '10')
  const indicator = screen.getByText(/Saved|Not saved/).textContent
  settings.update.mockClear()
  if (close) {
    settings.close()
  }
  await act(async () => {})
  expect({
    indicator,
    writes: settings.update.mock.calls,
    times: settings.saved().times
  }).toEqual({ indicator: 'Saved', writes: [], times: ['10:00', '16:00'] })
})

it.each([true, false])(
  'CS-C4-2: keeps a preset chosen while a first zone is pending (close before it resolves=%s)',
  async (close) => {
    const zone = deferred()
    mocks.probe.mockReturnValueOnce(zone.promise)
    const unzoned = { ...base.lookAround!, every: 'every-4h' as const, timezone: undefined }
    mocks.status = { setting: unzoned, upNext: { running: false, seenAt: 0, hostTimeZone: 'UTC' } }
    const settings = live(unzoned)
    settings.render()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'UTC' } })
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'mornings' } })
    if (close) {
      settings.close()
    }
    await act(async () => zone.resolve(true))
    await act(async () => {})
    expect(settings.saved()).toMatchObject({ every: 'mornings', timezone: 'UTC' })
  }
)
