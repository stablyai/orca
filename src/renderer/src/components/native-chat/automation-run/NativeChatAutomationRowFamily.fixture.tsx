import { defineFixture } from '../../../component-fixtures/component-fixture'
import { EVENT_ONLY_SCHEDULE } from '../../../../../shared/automation-event-triggers'
import type { AutomationRunMessage } from '../../../../../shared/automations/automation-run-message'
import type { BotAutomationFacts } from '../../../../../shared/bots/bot-automation-rows'
import { makeAutomationResultNote } from '../../../../../shared/bots/bot-automation-result-note'
import { NativeChatAutomationResultRow } from './NativeChatAutomationResultRow'
import { NativeChatAutomationRunRow } from './NativeChatAutomationRunRow'
import { NativeChatAutomationSavedRow } from './NativeChatAutomationSavedRow'
import { NativeChatWaitEndedRow } from './NativeChatWaitRow'

function NativeChatWaitRow({
  messageId,
  automation,
  once,
  timestamp
}: {
  messageId: string
  automation: Parameters<typeof NativeChatAutomationSavedRow>[0]['saved']['automation']
  once: NonNullable<
    Parameters<typeof NativeChatAutomationSavedRow>[0]['saved']['automation']['once']
  >
  timestamp: number | null
  ended?: unknown
}): React.JSX.Element {
  return (
    <NativeChatAutomationSavedRow
      saved={{ change: 'created', automation: { ...automation, once } }}
      timestamp={timestamp}
      disclosureId={messageId}
    />
  )
}

const AT = new Date(2026, 10, 16, 18, 41).getTime()
const min = (n: number): number => AT + n * 60_000

function automation(name: string, facts: Partial<BotAutomationFacts>): BotAutomationFacts {
  return {
    id: `auto-${name}`,
    name,
    enabled: true,
    nextRunAt: 0,
    updatedAt: AT,
    ...EVENT_ONLY_SCHEDULE,
    workspaceId: 'folder:bot',
    bot: { botId: 'bot-1' },
    ...facts
  }
}

const PR = automation('PR #858', {
  once: {},
  on: [
    {
      id: 'r1',
      source: 'github',
      event: 'ci_failed',
      subject: 'acme/widgets#858'
    }
  ]
})
// Ahead of the real clock, so these still read Waiting.
const NORA_BY = { by: Date.now() + 4 * 3_600_000 }
const NORA = automation("Nora's reply in #orca", {
  once: NORA_BY,
  on: [{ id: 'r2', source: 'slack', event: 'message', in: ['C1'] }]
})
const NORA_PAST_BY = { by: AT - 60_000 }
const NORA_PAST = { ...NORA, once: NORA_PAST_BY }
const REMINDER_BY = { by: Date.now() + 5 * 3_600_000 }
const REMINDER = automation('Release notes review', { once: REMINDER_BY })
const TRIAGE = automation('Morning triage', {
  dtstart: AT,
  rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0'
})
const BUGS = automation('Bug reports in #bugs', {
  on: [{ id: 'r3', source: 'slack', event: 'message', in: ['C2'] }]
})
const ISSUES = automation('New issues in orca', {
  on: [{ id: 'r4', source: 'linear', event: 'issue_created' }]
})

function run(
  runId: string,
  facts: BotAutomationFacts,
  rest: Partial<AutomationRunMessage>
): AutomationRunMessage {
  return { runId, automation: facts, trigger: 'event', instructionsLength: 0, ...rest }
}

const prRun = run('run-pr', PR, {
  wait: { kind: 'event', at: min(11) },
  event: {
    source: 'github',
    event: 'ci_failed',
    place: 'acme/widgets#858',
    occurredAt: min(11)
  }
})
const slackRun = run('run-slack', BUGS, {
  event: { source: 'slack', event: 'message', place: '#bugs', actor: 'Ana', occurredAt: min(30) }
})
const scheduledRun = run('run-sched', TRIAGE, { trigger: 'scheduled', scheduledFor: min(0) })
const linearRun = run('run-linear', ISSUES, {
  event: { source: 'linear', event: 'issue_created', place: 'ORC-42', occurredAt: min(40) }
})

const noop = (): void => {}

const family = (
  <div className="flex flex-col gap-3 bg-chat-canvas p-4">
    <NativeChatWaitRow messageId="w1" automation={PR} once={{}} timestamp={AT} />
    <NativeChatAutomationRunRow
      messageId="r1"
      run={prRun}
      state="ran"
      text=""
      timestamp={min(11)}
      onRefolded={noop}
    />
    <NativeChatWaitRow messageId="w2" automation={NORA} once={NORA_BY} timestamp={AT} />
    {/* Its creation row once the run came: Wait over, not Waiting. */}
    <NativeChatWaitRow
      messageId="w2-ran"
      automation={NORA}
      once={NORA_BY}
      ended={{ kind: 'event', at: min(43), actor: 'Nora' }}
      timestamp={AT}
    />
    {/* Past its deadline, how it ended shown elsewhere. */}
    <NativeChatWaitRow
      messageId="w2-past"
      automation={NORA_PAST}
      once={NORA_PAST_BY}
      timestamp={AT - 3_600_000}
    />
    <NativeChatWaitEndedRow
      messageId="e1"
      ended={{ automation: NORA, ending: { kind: 'event', at: min(43), actor: 'Nora' } }}
      timestamp={min(43)}
    />
    <NativeChatWaitEndedRow
      messageId="e2"
      ended={{ automation: NORA, ending: { kind: 'deadline', at: min(260) } }}
      timestamp={min(260)}
    />
    <NativeChatWaitRow messageId="w3" automation={REMINDER} once={REMINDER_BY} timestamp={AT} />
    <NativeChatWaitEndedRow
      messageId="e3"
      ended={{ automation: REMINDER, ending: { kind: 'expired', at: min(300) } }}
      timestamp={min(300)}
    />
    <NativeChatAutomationSavedRow
      saved={{ change: 'created', automation: TRIAGE }}
      timestamp={AT}
    />
    <NativeChatAutomationRunRow
      messageId="r2"
      run={scheduledRun}
      state="ran"
      text=""
      timestamp={min(0)}
      onRefolded={noop}
    />
    <NativeChatAutomationRunRow
      messageId="r3"
      run={slackRun}
      state="ran"
      text=""
      timestamp={min(30)}
      onRefolded={noop}
    />
    <NativeChatAutomationRunRow
      messageId="r4"
      run={linearRun}
      state="not-started"
      text=""
      timestamp={min(40)}
      onRefolded={noop}
    />
    <NativeChatAutomationResultRow
      note={makeAutomationResultNote({
        automationId: TRIAGE.id,
        automationName: 'Weekly digest',
        botName: 'Ranger',
        runId: 'run-digest',
        trigger: 'schedule',
        outcome: 'finished',
        result: 'Three advisories and two stale branches.',
        at: min(50)
      })}
    />
  </div>
)

export const wide = defineFixture({ width: 640, render: () => family })
export const narrow = defineFixture({ width: 360, render: () => family })

export const openedWait = defineFixture({
  width: 640,
  render: () => (
    <div className="bg-chat-canvas p-4">
      <NativeChatWaitRow messageId="open-w" automation={NORA} once={NORA_BY} timestamp={AT} />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

// A plain reminder (a time and no event): its Then line says only when it runs.
export const openedReminder = defineFixture({
  width: 640,
  render: () => (
    <div className="bg-chat-canvas p-4">
      <NativeChatWaitRow
        messageId="open-r"
        automation={REMINDER}
        once={REMINDER_BY}
        timestamp={AT}
      />
    </div>
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
