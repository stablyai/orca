import { defineFixture } from '../../../component-fixtures/component-fixture'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { makeAutomation, makeRun } from '../../automations/automations-page-fixtures'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../media/visuals/native-chat-visual-owner'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../messages/disclosure/native-chat-disclosure-store'

type Saved = NonNullable<NativeChatMessage['automationSaved']>

const HELP = 'slack:T1:C1'
const SLACK: AutomationEventTrigger = {
  id: 'on-1',
  source: 'slack',
  event: 'message',
  in: [HELP],
  names: { [HELP]: '#help' }
}
const DAILY = { dtstart: 0, rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30' }

const triage: Saved = {
  change: 'created',
  resultsTo: 'chat',
  automation: {
    id: 'auto-triage',
    name: 'Slack triage',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    ...EVENT_ONLY_SCHEDULE,
    workspaceId: null,
    on: [SLACK],
    bot: { botId: 'bot-1' }
  }
}

const digest: Saved = {
  change: 'created',
  resultsTo: 'chat',
  automation: {
    id: 'auto-digest',
    name: 'Morning digest',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    ...DAILY,
    workspaceId: null,
    bot: { botId: 'bot-1' }
  }
}

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000

/** The host's answers: the triage automation with two runs, the digest with none, a deleted one missing. */
function stubHost(): void {
  const records = {
    'auto-triage': makeAutomation({
      id: 'auto-triage',
      name: 'Slack triage',
      prompt: 'Read the message, label it, reply in thread.',
      agentId: 'claude',
      ...EVENT_ONLY_SCHEDULE,
      on: [SLACK],
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
    }),
    'auto-digest': makeAutomation({
      id: 'auto-digest',
      name: 'Morning digest',
      prompt: 'Summarize what changed overnight in #eng and open PRs.',
      agentId: 'claude',
      ...DAILY,
      bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' }
    })
  }
  const runs = {
    'auto-triage': [
      makeRun({
        id: 'r1',
        automationId: 'auto-triage',
        title: '#help · “login broken”',
        createdAt: minutesAgo(2)
      }),
      makeRun({
        id: 'r2',
        automationId: 'auto-triage',
        title: '#help · “invite me”',
        createdAt: minutesAgo(60)
      })
    ],
    'auto-digest': []
  }
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method, params }: { method: string; params: Record<string, string> }) => {
      if (method === 'automation.show') {
        const automation = Object.entries(records).find(([id]) => id === params.id)?.[1]
        return automation
          ? { ok: true, result: { automation } }
          : { ok: false, error: { code: 'runtime_error', message: 'Automation not found.' } }
      }
      if (method === 'automation.runs') {
        return {
          ok: true,
          result: {
            runs: Object.entries(runs).find(([id]) => id === params.automationId)?.[1] ?? []
          }
        }
      }
      return { ok: false, error: { code: 'runtime_error', message: 'not in this fixture' } }
    }
  })
}

const OWNER = {
  target: { kind: 'local' },
  sessionId: 's1',
  worktreeId: 'folder:fw-1',
  tabId: 'tab-1'
} as const

function Chat({ cards }: { cards: Saved[] }): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatVisualOwnerContext.Provider value={OWNER}>
      <NativeChatDisclosureContext.Provider value={disclosures}>
        <div className="flex flex-col gap-3 p-4">
          {cards.map((card) => (
            <NativeChatAutomationSavedRow
              key={card.automation.id}
              saved={card}
              timestamp={minutesAgo(3)}
              disclosureId={card.automation.id}
            />
          ))}
        </div>
      </NativeChatDisclosureContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}

async function clickToggle(name: string): Promise<void> {
  const toggle = [...document.querySelectorAll('button[aria-expanded]')].find((button) =>
    button.textContent?.includes(name)
  )
  if (toggle instanceof HTMLElement) {
    toggle.click()
  }
  // Let the host's answer land before the shot.
  await new Promise((resolve) => setTimeout(resolve, 400))
}

export const collapsed = defineFixture({
  width: 640,
  setup: stubHost,
  render: () => <Chat cards={[triage]} />
})

export const expanded = defineFixture({
  width: 640,
  setup: stubHost,
  render: () => <Chat cards={[triage]} />,
  interact: () => clickToggle('Slack triage')
})

export const expandedNarrow = defineFixture({
  width: 380,
  setup: stubHost,
  render: () => <Chat cards={[triage]} />,
  interact: () => clickToggle('Slack triage')
})

export const secondCardOpen = defineFixture({
  width: 640,
  setup: stubHost,
  render: () => <Chat cards={[triage, digest]} />,
  interact: async () => {
    await clickToggle('Slack triage')
    await clickToggle('Morning digest')
  }
})

export const deleted = defineFixture({
  width: 640,
  setup: stubHost,
  render: () => (
    <Chat
      cards={[
        { ...triage, automation: { ...triage.automation, id: 'auto-gone', name: 'Old triage' } }
      ]}
    />
  ),
  interact: () => clickToggle('Old triage')
})
