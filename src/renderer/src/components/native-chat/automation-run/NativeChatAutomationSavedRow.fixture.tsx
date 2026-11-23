import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { automationReceiptFacts } from '../../../../../shared/automations/automation-receipt-facts'
import { botAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { makeAutomation, makeRun } from '../../automations/automations-page-fixtures'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'

const SAVED_AT = Date.parse('2026-11-16T01:12:00Z')
const ZONE = 'America/Los_Angeles'
const base = makeAutomation({
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  nextRunAt: SAVED_AT + 86400000,
  name: 'Morning briefing',
  rrule: '0 9 * * 1-5',
  dtstart: SAVED_AT,
  timezone: ZONE,
  timezoneExplicit: true,
  prompt: 'Summarize the changes that need attention.',
  bot: { botId: 'bot-receipt', runsIn: 'new', resultsTo: 'chat' }
})
const scenarios = {
  schedule: { ...base, id: 'schedule' },
  event: {
    ...base,
    id: 'event',
    name: 'Triage incident messages',
    ...EVENT_ONLY_SCHEDULE,
    on: [
      {
        id: 's',
        source: 'slack',
        event: 'message',
        in: ['slack:T1:C1'],
        names: { 'slack:T1:C1': '#incidents' },
        textContains: 'urgent'
      }
    ]
  },
  wait: {
    ...base,
    id: 'wait',
    name: 'Follow up on the release reply',
    ...EVENT_ONLY_SCHEDULE,
    once: { by: SAVED_AT + 86400000 },
    on: [{ id: 'g', source: 'github', event: 'comment', subject: 'acme/website#482' }]
  },
  // An older receipt with no saved facts: its wait alternatives are not proven complete.
  waitLegacy: {
    ...base,
    id: 'wait-legacy',
    name: 'Follow up on the release reply',
    ...EVENT_ONLY_SCHEDULE,
    once: { by: SAVED_AT + 86400000 },
    on: [{ id: 'g', source: 'github', event: 'comment', subject: 'acme/website#482' }]
  },
  noDelivery: {
    ...base,
    id: 'no-delivery',
    name: 'Nightly cleanup',
    bot: { botId: 'bot-receipt', runsIn: 'new', resultsTo: 'none' }
  },
  paused: { ...base, id: 'paused', name: 'Weekly summary', enabled: false, rrule: '0 15 * * 5' },
  pausedChanged: {
    ...base,
    id: 'paused-changed',
    name: 'Saved Friday briefing',
    enabled: false,
    rrule: '0 15 * * 5'
  },
  pausedMissing: {
    ...base,
    id: 'paused-missing',
    name: 'Saved Friday briefing',
    enabled: false,
    rrule: '0 15 * * 5'
  },
  multipleStarts: {
    ...base,
    id: 'multiple-starts',
    name: 'Saved start alternatives',
    ...EVENT_ONLY_SCHEDULE,
    on: [
      { id: 'personal', source: 'gmail', event: 'new_email', account: 'personal@example.test' },
      {
        id: 'team',
        source: 'calendar',
        event: 'starting_soon',
        account: 'team@example.test',
        minutesBefore: 30
      },
      {
        id: 'slack',
        source: 'slack',
        event: 'message',
        in: ['slack:T1:C1'],
        names: { 'slack:T1:C1': '#incidents' },
        textContains: 'urgent'
      }
    ]
  },
  failed: {
    ...base,
    id: 'failed',
    name: 'Watch release CI',
    ...EVENT_ONLY_SCHEDULE,
    on: [{ id: 'ci', source: 'github', event: 'ci_failed', in: ['acme/website'] }]
  },
  missing: { ...base, id: 'missing', name: 'Previous morning briefing' },
  longName: {
    ...base,
    id: 'longName',
    name: 'A longer automation name for reviewing the release checklist and following up on every unresolved item'
  }
} satisfies Record<string, Automation>

type Scenario = keyof typeof scenarios
const OWNER = {
  target: { kind: 'local' },
  sessionId: 'fixture-chat',
  worktreeId: 'folder:receipt',
  tabId: 'fixture-tab'
} as const

function stubHost(scenario: Scenario): void {
  const automation = scenarios[scenario]
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) => {
      if (method === 'agentSession.automationReceipt') {
        return {
          ok: true,
          result:
            scenario === 'missing' || scenario === 'pausedMissing'
              ? { status: 'missing' }
              : {
                  status: 'ready',
                  automation:
                    scenario === 'pausedChanged'
                      ? {
                          ...automation,
                          name: 'Current weekday briefing',
                          enabled: true,
                          rrule: '0 8 * * 1-5'
                        }
                      : automation,
                  owner: { selector: { kind: 'self' } },
                  effectiveZone: ZONE
                }
        }
      }
      if (method === 'automation.runs') {
        return {
          ok: true,
          result: {
            runs:
              scenario === 'failed'
                ? [
                    makeRun({
                      id: 'failed-run',
                      automationId: 'failed',
                      title: 'Release CI',
                      createdAt: SAVED_AT + 1000,
                      status: 'dispatch_failed',
                      error: 'The host could not start the run.'
                    })
                  ]
                : []
          }
        }
      }
      return { ok: false, error: { code: 'runtime_error', message: 'Not in this fixture' } }
    }
  })
}

function Receipt({ scenario }: { scenario: Scenario }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  const automation = scenarios[scenario]
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      <NativeChatDisclosureContext.Provider value={disclosures}>
        <div
          data-native-chat-root
          className="native-chat-appearance flex flex-col gap-5 bg-chat-canvas p-4 text-sm text-chat-foreground"
          style={nativeChatAppearanceStyle({
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
          })}
        >
          <p>I’ll save that automation for you.</p>
          <p className="self-end rounded-xl border border-chat-user-border bg-chat-user-surface px-3 py-2 text-chat-foreground">
            Sounds good, go ahead.
          </p>
          <NativeChatAutomationSavedRow
            saved={{
              change: 'created',
              automation: botAutomationFacts(automation),
              receiptFacts:
                scenario === 'waitLegacy' ? undefined : automationReceiptFacts(automation, ZONE),
              resultsTo: scenario === 'noDelivery' ? 'none' : 'chat'
            }}
            timestamp={SAVED_AT}
            disclosureId={automation.id}
          />
          <p>You can open it to review the settings.</p>
        </div>
      </NativeChatDisclosureContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}

function receiptFixture(scenario: Scenario, width: number): ComponentFixture {
  return defineFixture({
    width,
    setup: () => stubHost(scenario),
    render: () => <Receipt scenario={scenario} />,
    ...(scenario === 'failed' || scenario === 'missing' || scenario === 'pausedMissing'
      ? {
          interact: async (frame: HTMLElement) => {
            frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
            // The fixture host resolves immediately; allow its React commit before capture.
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        }
      : {})
  })
}

export const scheduleWide = receiptFixture('schedule', 640)
export const scheduleNarrow = receiptFixture('schedule', 380)
export const eventWide = receiptFixture('event', 640)
export const eventNarrow = receiptFixture('event', 380)
export const waitWide = receiptFixture('wait', 640)
export const waitNarrow = receiptFixture('wait', 380)
export const pausedWide = receiptFixture('paused', 640)
export const pausedNarrow = receiptFixture('paused', 380)
export const failedWide = receiptFixture('failed', 640)
export const failedNarrow = receiptFixture('failed', 380)
export const missingWide = receiptFixture('missing', 640)
export const missingNarrow = receiptFixture('missing', 380)
export const longNameWide = receiptFixture('longName', 640)
export const longNameNarrow = receiptFixture('longName', 380)

export const pausedChangedWide = receiptFixture('pausedChanged', 640)
export const pausedChangedNarrow = receiptFixture('pausedChanged', 380)
export const pausedMissingWide = receiptFixture('pausedMissing', 640)
export const pausedMissingNarrow = receiptFixture('pausedMissing', 380)
export const multipleStartsWide = receiptFixture('multipleStarts', 640)
export const multipleStartsNarrow = receiptFixture('multipleStarts', 380)
export const waitLegacyWide = receiptFixture('waitLegacy', 640)
export const waitLegacyNarrow = receiptFixture('waitLegacy', 380)
export const noDeliveryWide = receiptFixture('noDelivery', 640)
export const noDeliveryNarrow = receiptFixture('noDelivery', 380)
