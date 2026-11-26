// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { webhookRuleId } from '../../../../../shared/connector-webhook-contract'
import { automationWebhookUrlCopy } from '../../bots/webhooks/automation-webhook-url'
import { setWebhookHostTransportForTests } from '../../bots/webhooks/webhook-host-client'
import { webhookSummaryFixture } from '../../bots/webhooks/webhook-summary.test-fixture'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'

const HOOK = 'wh_SetupCardTest001'
// A hook the host no longer has: its read fails.
const GONE = 'wh_SetupCardGone001'
const URL = `https://connector.orca.dev/hooks/${HOOK}/secret-key`
const writes: string[] = []
const reveals: unknown[] = []

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  writes.length = 0
  reveals.length = 0
  setWebhookHostTransportForTests(async (target, method, params) => {
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
