import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { automationReceiptFacts } from '../../../../../shared/automations/automation-receipt-facts'
import { botAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { makeAutomation, makeRun } from '../../automations/automations-page-fixtures'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
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
  paused: { ...base, id: 'paused', name: 'Weekly summary', enabled: false, rrule: '0 15 * * 5' },
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
            scenario === 'missing'
              ? { status: 'missing' }
              : {
                  status: 'ready',
                  automation,
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
        <div className="p-4">
          <NativeChatAutomationSavedRow
            saved={{
              change: 'created',
              automation: botAutomationFacts(automation),
              receiptFacts: automationReceiptFacts(automation, ZONE),
              resultsTo: 'chat'
            }}
            timestamp={SAVED_AT}
            disclosureId={automation.id}
          />
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
    ...(scenario === 'failed' || scenario === 'missing'
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
