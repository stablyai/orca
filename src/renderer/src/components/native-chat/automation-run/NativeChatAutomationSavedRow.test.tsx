// @vitest-environment happy-dom

import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'

// A folded Open's reply is only honored while it is still the newest card intent, and a pane
// hidden by <Activity> must not keep the Open disabled after a successful navigation.

const harness = vi.hoisted(() => ({
  replies: [] as PromiseWithResolvers<'opened' | 'unavailable' | 'stale'>[],
  toasts: [] as unknown[]
}))
vi.mock('../automation-receipt-client', () => ({
  openCardAutomation: () => {
    const reply = Promise.withResolvers<'opened' | 'unavailable' | 'stale'>()
    harness.replies.push(reply)
    return reply.promise
  }
}))
vi.mock('sonner', () => ({
  toast: { error: (message: unknown) => harness.toasts.push(message), message: () => {} }
}))
vi.mock('../NativeChatAutomationCardDetails', () => ({
  NativeChatAutomationCardDetails: () => <div data-testid="details" />
}))

const saved = (id: string) => ({
  change: 'created' as const,
  automation: {
    id,
    name: `Automation ${id}`,
    enabled: false,
    nextRunAt: 0,
    updatedAt: 1,
    dtstart: 0,
    rrule: '0 9 * * 1',
    workspaceId: null
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  harness.replies.length = 0
  harness.toasts.length = 0
})

function Transcript({ visible = true }: { visible?: boolean }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        {['A', 'B'].map((id) => (
          <div key={id} data-row={id}>
            <NativeChatAutomationSavedRow saved={saved(id)} timestamp={null} disclosureId={id} />
          </div>
        ))}
      </Activity>
    </NativeChatDisclosureContext.Provider>
  )
}

const row = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-row="${id}"]`)!
const openButton = (id: string): HTMLButtonElement | undefined =>
  [...row(id).querySelectorAll('button')].find((button) => button.textContent === 'Open')
const toggle = (id: string): HTMLButtonElement =>
  row(id).querySelector<HTMLButtonElement>('button[aria-expanded]')!
const expanded = (id: string): boolean => toggle(id).getAttribute('aria-expanded') === 'true'

async function settle(
  index: number,
  outcome: 'opened' | 'unavailable' | 'stale' | Error
): Promise<void> {
  await act(async () => {
    if (outcome instanceof Error) {
      harness.replies[index].reject(outcome)
    } else {
      harness.replies[index].resolve(outcome)
    }
    await harness.replies[index].promise.catch(() => {})
  })
}

it.each(['unavailable', 'rejected'] as const)(
  'keeps a card the reader expanded after an earlier Open settles %s',
  async (outcome) => {
    act(() => root.render(<Transcript />))
    act(() => openButton('A')!.click())
    act(() => toggle('B').click())
    expect(expanded('B')).toBe(true)
    await settle(0, outcome === 'rejected' ? new Error('host unreachable') : 'unavailable')
    expect(expanded('B')).toBe(true)
    expect(expanded('A')).toBe(false)
    expect(harness.toasts).toEqual([])
    expect(openButton('A')!.disabled).toBe(false)
  }
)

it('does nothing visible for a stale reply and still honors a fresh Open', async () => {
  act(() => root.render(<Transcript />))
  act(() => openButton('A')!.click())
  expect(openButton('A')!.disabled).toBe(true)
  await settle(0, 'stale')
  expect(expanded('A')).toBe(false)
  expect(harness.toasts).toEqual([])
  expect(openButton('A')!.disabled).toBe(false)
  act(() => openButton('A')!.click())
  await settle(1, 'unavailable')
  expect(expanded('A')).toBe(true)
})

it('re-enables Open after a successful navigation hides the pane and the reader returns', async () => {
  act(() => root.render(<Transcript />))
  act(() => openButton('A')!.click())
  act(() => root.render(<Transcript visible={false} />))
  await settle(0, 'opened')
  act(() => root.render(<Transcript />))
  expect(openButton('A')!.disabled).toBe(false)
  act(() => openButton('A')!.click())
  expect(harness.replies).toHaveLength(2)
})
