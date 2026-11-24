import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { webhookRuleId } from '../../../../../shared/connector-webhook-contract'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { automationReceiptFacts } from '../../../../../shared/automations/automation-receipt-facts'
import { botAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { setWebhookHostTransportForTests } from '../../bots/webhooks/webhook-host-client'
import { webhookSummaryFixture } from '../../bots/webhooks/webhook-summary.test-fixture'
import { makeAutomation } from '../../automations/automations-page-fixtures'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'

const OWNER = {
  target: { kind: 'local' },
  sessionId: 's1',
  worktreeId: 'folder:fw-1',
  tabId: 'tab-1'
} as const

// Each state its own hook, so one fixture's cached host read never answers another's.
const HOOKS = {
  pending: 'wh_PendingPendingPe',
  created: 'wh_CreatedCreatedCr',
  opened: 'wh_OpenedOpenedOpen',
  copied: 'wh_CopiedCopiedCopi',
  called: 'wh_CalledCalledCall',
  unverified: 'wh_UnverifiedUnveri'
} as const
type State = keyof typeof HOOKS

function automationFor(hookId: string): Automation {
  return makeAutomation({
    id: `auto-${hookId}`,
    name: 'Failed payment follow-up',
    createdAt: 1_700_000_000_000,
    updatedAt: 0,
    nextRunAt: 0,
    ...EVENT_ONLY_SCHEDULE,
    on: [{ id: webhookRuleId(hookId), source: 'webhook', event: 'call', rev: 1 }],
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
  })
}

function saved(hookId: string): NonNullable<NativeChatMessage['automationSaved']> {
  const automation = automationFor(hookId)
  return {
    change: 'created',
    resultsTo: 'chat',
    automation: botAutomationFacts(automation),
    receiptFacts: automationReceiptFacts(automation)
  }
}

function summaryFor(hookId: string): WebhookSummary {
  const state = Object.entries(HOOKS).find(([, id]) => id === hookId)?.[0]
  return webhookSummaryFixture({
    hookId,
    automationName: 'Failed payment follow-up',
    state: state === 'pending' ? 'pending' : 'live',
    ...(state === 'called'
      ? {
          adapter: 'stripe',
          lastCall: { at: Date.now() - 2 * 60_000, state: 'started', signatureValid: true }
        }
      : {})
  })
}

function stubHost(): void {
  setWebhookHostTransportForTests(async (_target, method, params) => {
    const hookId = 'hookId' in params ? params.hookId : ''
    if (method === 'webhooks.card') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers webhooks.card, whose result is a WebhookSummary.
      return summaryFor(hookId) as never
    }
    if (method === 'webhooks.reveal') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answers webhooks.reveal, whose result is a WebhookKey.
      return { url: `https://connector.orca.dev/hooks/${hookId}/k3y`, key: 'k3y' } as never
    }
    throw new Error('not in this fixture')
  })
  Reflect.set(window.api.ui, 'writeSecretClipboardText', async () => ({ clearsLater: true }))
  // Setup appears only once the chat's host confirms the receipt as its own webhook automation.
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method, params }: { method: string; params: { itemId?: string } }) => {
      if (method !== 'agentSession.automationReceipt') {
        return { ok: false, error: { code: 'runtime_error', message: 'Not in this fixture' } }
      }
      const hookId = params.itemId ?? ''
      return {
        ok: true,
        result:
          hookId === HOOKS.unverified
            ? { status: 'missing' }
            : {
                status: 'ready',
                automation: automationFor(hookId),
                owner: { selector: { kind: 'self' } }
              }
      }
    }
  })
}

function Chat({ state }: { state: State }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <ConfirmationDialogProvider>
      <NativeChatVisualOwnerContext.Provider value={OWNER}>
        <NativeChatDisclosureContext.Provider value={disclosures}>
          <div className="flex flex-col gap-3 p-4">
            <NativeChatAutomationSavedRow
              saved={saved(HOOKS[state])}
              timestamp={SAVED_AT}
              disclosureId={HOOKS[state]}
            />
          </div>
        </NativeChatDisclosureContext.Provider>
      </NativeChatVisualOwnerContext.Provider>
    </ConfirmationDialogProvider>
  )
}

const SAVED_AT = Date.now() - 3 * 60_000

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

async function click(label: string): Promise<void> {
  await settle()
  const button = [...document.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(label)
  )
  button?.click()
  await settle()
}

export const settingUp = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="pending" />,
  interact: settle
})

export const justCreated = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="created" />,
  interact: settle
})

export const keyAndSecretOpened = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="opened" />,
  interact: () => click('Key and signing secret')
})

export const afterCopy = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="copied" />,
  interact: () => click('Copy URL')
})

export const firstCallReceived = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="called" />,
  interact: settle
})

export const narrow = defineFixture({
  width: 360,
  setup: stubHost,
  render: () => <Chat state="opened" />,
  interact: () => click('Key and signing secret')
})

// A receipt its host can't confirm stays a saved row: no live setup controls.
export const unverifiedReceipt = defineFixture({
  width: 736,
  setup: stubHost,
  render: () => <Chat state="unverified" />,
  interact: settle
})
