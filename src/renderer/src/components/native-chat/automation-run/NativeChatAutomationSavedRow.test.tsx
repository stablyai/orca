// @vitest-environment happy-dom

import { Activity, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import type { VerifiedReceiptWebhook } from './use-verified-receipt-webhook'

// A folded Open's reply is only honored while it is still the newest card intent, and a pane
// hidden by <Activity> must not keep the Open disabled after a successful navigation.

type Harness = {
  replies: PromiseWithResolvers<'opened' | 'unavailable' | 'stale'>[]
  toasts: unknown[]
  owner: null | { worktreeId: string; target: { kind: 'local' } }
  verified: VerifiedReceiptWebhook | null
  bots: Map<string, { id: string; name: string }[]>
  botReads: string[]
  botListeners: Set<() => void>
  workspaceBotReads: (string | null)[]
}
const harness = vi.hoisted((): Harness => ({
  replies: [],
  toasts: [],
  owner: null,
  verified: null,
  bots: new Map(),
  botReads: [],
  botListeners: new Set(),
  workspaceBotReads: []
}))
vi.mock('../media/visuals/native-chat-visual-owner', () => ({
  useNativeChatVisualOwner: () => harness.owner
}))
// The card's caption reads the catalog as already loaded; nothing here may start a catalog refresh.
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readHostBots: (hostId: string) => {
    harness.botReads.push(hostId)
    return harness.bots.get(hostId) ?? []
  },
  subscribeToBotChanges: (listener: () => void) => {
    harness.botListeners.add(listener)
    return () => harness.botListeners.delete(listener)
  }
}))
// The containing workspace's bot lookup subscribes the shared catalog; a receipt never uses it.
vi.mock('@/components/bots/bot-workspace', () => ({
  useBotForWorkspace: (worktreeId: string | null) => {
    harness.workspaceBotReads.push(worktreeId)
    return null
  }
}))
vi.mock('./use-verified-receipt-webhook', () => ({
  useVerifiedReceiptWebhook: () => harness.verified
}))
vi.mock('./NativeChatWebhookSetupCard', () => ({
  NativeChatWebhookSetupCard: ({
    hookId,
    botName,
    target
  }: {
    hookId: string
    botName: string
    target: VerifiedReceiptWebhook['target']
  }) => (
    <div data-testid="webhook-card">
      <span data-hook>{hookId}</span>
      <span data-bot>{botName}</span>
      <span data-target>
        {target.kind === 'environment' && target.binding
          ? `${target.environmentId}@${target.binding.pairingRevision}:${target.binding.runtimeId}`
          : target.kind}
      </span>
    </div>
  )
}))
vi.mock('../automation-receipt-client', () => ({
  openCardAutomation: () => {
    const reply = Promise.withResolvers<'opened' | 'unavailable' | 'stale'>()
    harness.replies.push(reply)
    return reply.promise
  }
}))
vi.mock('sonner', () => ({
  toast: {
    error: (message: unknown) => harness.toasts.push(message),
    message: () => {}
  }
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
  harness.owner = null
  harness.verified = null
  harness.bots.clear()
  harness.botReads.length = 0
  harness.botListeners.clear()
  harness.workspaceBotReads.length = 0
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

it('releases a superseded Open before its reply and keeps the newer Open busy when it lands', async () => {
  act(() => root.render(<Transcript />))
  act(() => openButton('A')!.click())
  expect(openButton('A')!.disabled).toBe(true)
  act(() => openButton('B')!.click())
  // A's reply has not settled, yet A is re-armed at once.
  expect(openButton('A')!.disabled).toBe(false)
  expect(openButton('B')!.disabled).toBe(true)
  act(() => openButton('A')!.click())
  expect(harness.replies).toHaveLength(3)
  expect(openButton('B')!.disabled).toBe(false)
  await settle(0, 'unavailable')
  await settle(1, new Error('host unreachable'))
  expect(openButton('A')!.disabled).toBe(true)
  expect(expanded('A')).toBe(false)
  expect(expanded('B')).toBe(false)
  expect(harness.toasts).toEqual([])
  await settle(2, 'unavailable')
  expect(expanded('A')).toBe(true)
})

it('releases an Open superseded by a disclosure toggle before its reply', async () => {
  act(() => root.render(<Transcript />))
  act(() => openButton('A')!.click())
  act(() => toggle('B').click())
  expect(openButton('A')!.disabled).toBe(false)
  act(() => openButton('A')!.click())
  expect(harness.replies).toHaveLength(2)
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

function renderWebhookReceipt(): void {
  harness.owner = { worktreeId: 'wt', target: { kind: 'local' } }
  const webhook = saved('W')
  const automation = {
    ...webhook.automation,
    on: [
      {
        id: 'wh-wh_abcdefgh12345678',
        source: 'webhook' as const,
        event: 'call' as const
      }
    ]
  }
  act(() =>
    root.render(
      <NativeChatAutomationSavedRow
        saved={{ ...webhook, automation }}
        timestamp={null}
        disclosureId="W"
      />
    )
  )
}

const boundTarget = {
  kind: 'environment' as const,
  environmentId: 'E',
  binding: { pairingRevision: 7, runtimeId: 'W', current: () => true }
}
const card = (part: 'hook' | 'bot' | 'target'): string | null | undefined =>
  container.querySelector(`[data-testid="webhook-card"] [data-${part}]`)?.textContent

it('draws a host-verified webhook receipt as its setup card, bound to the confirming host', () => {
  harness.verified = { hookId: 'wh_abcdefgh12345678', target: boundTarget, botId: 'bot-R' }
  harness.bots.set('runtime:E', [{ id: 'bot-R', name: 'Receipt bot' }])
  renderWebhookReceipt()
  expect(card('hook')).toBe('wh_abcdefgh12345678')
  // Every Setup control gets the host as confirmed: its pairing and runtime, not just its id.
  expect(card('target')).toBe('E@7:W')
  expect(container.querySelector('button[aria-expanded]')).toBeNull()
})

it('captions Setup with the receipt’s own bot on the confirming host, not the workspace’s', () => {
  harness.verified = { hookId: 'wh_abcdefgh12345678', target: boundTarget, botId: 'bot-R' }
  // The containing workspace's bot and a same-id bot on another host must not name it.
  harness.bots.set('local', [{ id: 'bot-R', name: 'Local namesake' }])
  harness.bots.set('runtime:E', [{ id: 'bot-W', name: 'Workspace bot' }])
  renderWebhookReceipt()
  expect(card('bot')).toBe('the bot')
  // The catalog loads the receipt's bot later; its change notice renames the card.
  harness.bots.set('runtime:E', [
    { id: 'bot-W', name: 'Workspace bot' },
    { id: 'bot-R', name: 'Receipt bot' }
  ])
  act(() => harness.botListeners.forEach((listener) => listener()))
  expect(card('bot')).toBe('Receipt bot')
  expect(new Set(harness.botReads)).toEqual(new Set(['runtime:E']))
  // One change listener for the card; no shared catalog subscription or refresh.
  expect(harness.botListeners.size).toBe(1)
  expect(harness.workspaceBotReads).toEqual([])
})

it('keeps an unverified webhook receipt a saved row with no live setup controls', () => {
  renderWebhookReceipt()
  expect(container.querySelector('[data-testid="webhook-card"]')).toBeNull()
  expect(container.querySelector('button[aria-expanded]')).not.toBeNull()
  expect(harness.botReads).toEqual([])
  expect(harness.botListeners.size).toBe(0)
})

it('acquires no bot catalog for folded receipts, on first mount or with several rows', () => {
  harness.owner = { worktreeId: 'wt', target: { kind: 'local' } }
  act(() => root.render(<Transcript />))
  act(() => root.render(<Transcript />))
  expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(2)
  expect(harness.botReads).toEqual([])
  expect(harness.botListeners.size).toBe(0)
})
