// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { webhookRuleId } from '../../../../../shared/connector-webhook-contract'
import { automationWebhookUrlCopy } from '../../bots/webhooks/automation-webhook-url'
import {
  setWebhookHostTransportForTests,
  type WebhookHostTarget
} from '../../bots/webhooks/webhook-host-client'
import { webhookSummaryFixture } from '../../bots/webhooks/webhook-summary.test-fixture'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'

// The card's own behavior, past the host check use-verified-receipt-webhook.test.tsx covers.
const confirmed = vi.hoisted(() => ({ target: null as WebhookHostTarget | null }))
vi.mock('./use-verified-receipt-webhook', async () => {
  const { automationHookId } = await import('../../../../../shared/automation-event-triggers')
  return {
    useVerifiedReceiptWebhook: (
      owner: { target: WebhookHostTarget },
      _itemId: unknown,
      saved: { automation: Parameters<typeof automationHookId>[0] }
    ) => {
      const hookId = automationHookId(saved.automation)
      return hookId ? { hookId, target: confirmed.target ?? owner.target, botId: 'bot-1' } : null
    }
  }
})

const HOOK = 'wh_SetupCardTest001'
// Its own hook, since a hook copied once keeps its copied receipt for the session.
const BOUND = 'wh_SetupCardBound01'
// A hook the host no longer has: its read fails.
const GONE = 'wh_SetupCardGone001'
const URL = `https://connector.orca.dev/hooks/${HOOK}/secret-key`
const writes: string[] = []
const reveals: unknown[] = []
const sent: { method: string; target: unknown; binding: unknown }[] = []
let replyGate: Promise<void> | null = null

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  writes.length = 0
  reveals.length = 0
  sent.length = 0
  replyGate = null
  confirmed.target = null
  setWebhookHostTransportForTests(async (target, method, params, binding) => {
    sent.push({ method, target, binding })
    if (method === 'webhooks.reveal' && replyGate) {
      await replyGate
    }
    if ('hookId' in params && params.hookId === GONE) {
      throw new Error('webhook_not_found')
    }
    if (method === 'webhooks.card') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers webhooks.card, whose result is a WebhookSummary.
      return webhookSummaryFixture({ hookId: HOOK }) as never
    }
    if (method === 'webhooks.reveal') {
      reveals.push(target)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers webhooks.reveal, whose result is a WebhookKey.
      return { url: URL, key: 'secret-key' } as never
    }
    throw new Error(`unexpected ${method}`)
  })
  vi.stubGlobal('api', {
    ...window.api,
    ui: {
      ...window.api?.ui,
      writeSecretClipboardText: async (text: string) => {
        writes.push(text)
        return { clearsLater: true }
      }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setWebhookHostTransportForTests(null)
  vi.unstubAllGlobals()
})

const automation = {
  id: 'auto-1',
  name: 'Failed payment follow-up',
  enabled: true,
  nextRunAt: 0,
  updatedAt: 0,
  ...EVENT_ONLY_SCHEDULE,
  workspaceId: null,
  on: [{ id: webhookRuleId(HOOK), source: 'webhook' as const, event: 'call' as const }],
  bot: { botId: 'bot-1' }
}

const OWNER = { target: { kind: 'local' }, sessionId: 's1', worktreeId: 'folder:fw-1' } as const
const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
function renderSaved(hookId: string): void {
  act(() =>
    root.render(
      <NativeChatVisualOwnerContext.Provider value={OWNER}>
        <NativeChatAutomationSavedRow
          saved={{
            change: 'created',
            resultsTo: 'chat',
            automation: {
              ...automation,
              on: [{ id: webhookRuleId(hookId), source: 'webhook', event: 'call' }]
            }
          }}
          timestamp={0}
        />
      </NativeChatVisualOwnerContext.Provider>
    )
  )
}
const copyButton = (): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy URL')

it('draws a created webhook automation with Copy URL in view, and copies the key-bearing URL', async () => {
  act(() =>
    root.render(
      <NativeChatVisualOwnerContext.Provider value={OWNER}>
        <NativeChatAutomationSavedRow
          saved={{ change: 'created', resultsTo: 'chat', automation }}
          timestamp={0}
        />
      </NativeChatVisualOwnerContext.Provider>
    )
  )
  await settle()
  // Nothing to open first: the button is on the card itself.
  expect(container.querySelector('[aria-expanded="true"]')).toBeNull()
  const button = copyButton()
  expect(button?.disabled).toBe(false)

  act(() => button!.click())
  await settle()
  await settle()
  expect(writes).toEqual([URL])
  expect(container.textContent).toContain('✓ URL copied')
  expect(container.textContent).not.toContain(URL)
})

it('copies from the automation bot’s own host, and offers nothing for an automation no hook starts', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy reads only a bot's id, name and host.
  const bot = { id: 'bot-1', name: 'billing', hostId: 'local' } as never
  expect(automationWebhookUrlCopy({ ...automation, on: [] }, [bot])).toBeNull()
  expect(automationWebhookUrlCopy(automation, [])).toBeNull()

  automationWebhookUrlCopy(automation, [bot])?.()
  await settle()
  await settle()
  expect(reveals).toEqual([{ kind: 'local' }])
  expect(writes).toEqual([URL])
})

it('offers no key panel when the hook cannot be read', async () => {
  renderSaved(GONE)
  await settle()
  expect(copyButton()).toBeDefined()
  expect(container.textContent).not.toContain('Key and signing secret')
})

it('sends every Setup read and control only to the host incarnation that confirmed the receipt', async () => {
  let current = true
  confirmed.target = {
    kind: 'environment',
    environmentId: 'E',
    binding: { pairingRevision: 7, runtimeId: 'W', current: () => current }
  }
  renderSaved(BOUND)
  await settle()
  act(() => copyButton()!.click())
  await settle()
  await settle()
  expect(writes).toEqual([URL])
  expect(sent.map(({ method }) => method)).toEqual(
    expect.arrayContaining(['webhooks.card', 'webhooks.reveal'])
  )
  for (const call of sent) {
    expect(call).toEqual({
      method: call.method,
      target: { kind: 'environment', environmentId: 'E' },
      binding: { pairingRevision: 7, runtimeId: 'W' }
    })
  }

  // A key revealed after the host changed is never copied.
  writes.length = 0
  const held = Promise.withResolvers<void>()
  replyGate = held.promise
  const copyAgain = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Copied'
  )
  act(() => copyAgain!.click())
  await settle()
  current = false
  held.resolve()
  await settle()
  await settle()
  expect(sent.filter(({ method }) => method === 'webhooks.reveal')).toHaveLength(2)
  expect(writes).toEqual([])
})
