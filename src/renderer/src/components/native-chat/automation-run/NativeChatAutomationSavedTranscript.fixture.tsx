import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import { botAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { makeAutomation } from '../../automations/automations-page-fixtures'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatWaitRow } from './NativeChatWaitRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'

// Saved automations between real transcript text and a user bubble, on the chat's own canvas.
const SAVED_AT = Date.parse('2026-11-16T01:12:00Z')
const base = makeAutomation({
  createdAt: SAVED_AT,
  updatedAt: SAVED_AT,
  nextRunAt: SAVED_AT + 86_400_000,
  name: 'Morning briefing',
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
  dtstart: SAVED_AT,
  prompt: 'Summarize the changes that need attention.',
  agentId: 'claude',
  bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
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
        names: { 'slack:T1:C1': '#incidents' }
      }
    ]
  },
  paused: {
    ...base,
    id: 'paused',
    name: 'Weekly summary',
    enabled: false,
    rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=15;BYMINUTE=0'
  },
  longName: {
    ...base,
    id: 'long-name',
    name: 'A longer automation name for reviewing the release checklist and following up on every unresolved item'
  },
  wait: {
    ...base,
    id: 'wait',
    name: 'Follow up on the release reply',
    ...EVENT_ONLY_SCHEDULE,
    once: { by: SAVED_AT + 86_400_000 },
    on: [{ id: 'g', source: 'github', event: 'comment', subject: 'acme/website#482' }]
  }
} satisfies Record<string, Automation>

type Scenario = keyof typeof scenarios

const OWNER = {
  target: { kind: 'local' },
  sessionId: 'fixture-chat',
  worktreeId: 'folder:fixture',
  tabId: 'fixture-tab'
} as const

function stubHost(): void {
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method, params }: { method: string; params: Record<string, string> }) => {
      if (method === 'automation.show') {
        const automation = Object.values(scenarios).find((entry) => entry.id === params.id)
        return automation
          ? { ok: true, result: { automation } }
          : { ok: false, error: { code: 'runtime_error', message: 'Automation not found.' } }
      }
      if (method === 'automation.runs') {
        return { ok: true, result: { runs: [] } }
      }
      return { ok: false, error: { code: 'runtime_error', message: 'Not in this fixture' } }
    }
  })
}

function Transcript({ scenario }: { scenario: Scenario }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  const automation = scenarios[scenario]
  const facts = botAutomationFacts(automation)
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
          {facts.once ? (
            <NativeChatWaitRow
              messageId={automation.id}
              automation={facts}
              once={facts.once}
              timestamp={SAVED_AT}
            />
          ) : (
            <NativeChatAutomationSavedRow
              saved={{ change: 'created', automation: facts, resultsTo: 'chat' }}
              timestamp={SAVED_AT}
              disclosureId={automation.id}
            />
          )}
          <p>You can open it to review the settings.</p>
        </div>
      </NativeChatDisclosureContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}

function transcriptFixture(scenario: Scenario, width: number, expand = false): ComponentFixture {
  return defineFixture({
    width,
    setup: stubHost,
    render: () => <Transcript scenario={scenario} />,
    ...(expand
      ? {
          interact: async (frame: HTMLElement) => {
            frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
            // Let the stubbed host's answer land before the shot.
            await new Promise((resolve) => setTimeout(resolve, 300))
          }
        }
      : {})
  })
}

export const scheduleWide = transcriptFixture('schedule', 640)
export const scheduleNarrow = transcriptFixture('schedule', 380)
export const eventWide = transcriptFixture('event', 640)
export const eventNarrow = transcriptFixture('event', 380)
export const pausedWide = transcriptFixture('paused', 640)
export const pausedNarrow = transcriptFixture('paused', 380)
export const longNameWide = transcriptFixture('longName', 640)
export const longNameNarrow = transcriptFixture('longName', 380)
export const waitWide = transcriptFixture('wait', 640)
export const waitNarrow = transcriptFixture('wait', 380)
export const expandedWide = transcriptFixture('schedule', 640, true)
export const expandedNarrow = transcriptFixture('schedule', 380, true)
