import { defineFixture } from '../../component-fixtures/component-fixture'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationFacts } from '../../../../shared/bots/bot-automation-rows'
import { EVENT_ONLY_SCHEDULE } from '../../../../shared/automation-event-triggers'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatAutomationSavedRow } from '../native-chat/automation-run/NativeChatAutomationSavedRow'
import { NativeChatVisualOwnerContext } from '../native-chat/media/visuals/native-chat-visual-owner'
import { NativeChatWaitEndedRow } from '../native-chat/automation-run/NativeChatWaitRow'
import BotActivityPanel from './BotActivityPanel'

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

const ranger: Bot = {
  id: 'bot-ranger',
  name: 'Ranger',
  hostId: 'local',
  folder: 'ranger',
  folderWorkspaceId: 'fw-ranger',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-ranger',
  createdAt: 1,
  updatedAt: 1
}
const home = folderWorkspaceKey(ranger.folderWorkspaceId)

// The coming Friday, 5 PM, on this machine's clock.
function nextFriday5pm(): number {
  const at = new Date()
  at.setDate(at.getDate() + ((5 - at.getDay() + 7) % 7 || 7))
  at.setHours(17, 0, 0, 0)
  return at.getTime()
}

function facts(fields: Partial<BotAutomationFacts> & Pick<BotAutomationFacts, 'id' | 'name'>) {
  return {
    enabled: true,
    nextRunAt: EVENT_ONLY_SCHEDULE.dtstart,
    updatedAt: 1,
    ...EVENT_ONLY_SCHEDULE,
    workspaceId: home,
    bot: { botId: ranger.id },
    ...fields
  }
}

const deadline = nextFriday5pm()
const nora = facts({
  id: 'wait-nora',
  name: 'Nora’s reply in your #orca thread',
  on: [{ id: 't1', source: 'slack', event: 'message', subject: 'T1:C1:1700.01' }],
  once: { by: deadline }
})
const row = (automation: BotAutomationFacts) => ({ key: automation.id, automation, failing: false })

const activity: BotActivity = {
  workers: [],
  inProgress: [],
  completed: [],
  waits: [
    row({ ...nora, name: 'Nora’s reply in #orca' }),
    row(
      facts({
        id: 'wait-ci',
        name: 'CI on stablyai/orca#400',
        on: [{ id: 't2', source: 'github', event: 'ci_failed', subject: 'stablyai/orca#400' }],
        once: {}
      })
    )
  ],
  automations: [
    row(
      facts({
        id: 'a-langsmith',
        name: 'Auto-resolve LangSmith alerts',
        on: [{ id: 'webhook:h1', source: 'webhook', event: 'call' }]
      })
    ),
    row(
      facts({
        id: 'a-scout',
        name: 'Scout S4 post',
        enabled: false,
        rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30',
        dtstart: 1
      })
    )
  ]
}

function stubHost(bot: Bot = ranger): void {
  publishBots([bot])
  Reflect.set(window.api.runtime, 'call', async ({ method }: { method: string }) => ({
    id: 'fixture',
    ok: true,
    result: method === 'bots.activity' ? { activity } : { bots: [bot] },
    _meta: { runtimeId: 'fixture' }
  }))
}

const owner = { target: { kind: 'local' as const }, sessionId: 'chat-ranger', worktreeId: home }

function InChat({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <div className="p-3">{children}</div>
    </NativeChatVisualOwnerContext.Provider>
  )
}

const today214am = (): number => new Date().setHours(2, 14, 0, 0)

export const sidebar = defineFixture({
  width: 320,
  store: { activeWorktreeId: home },
  setup: () => stubHost(),
  render: () => <BotActivityPanel />
})

export const chatWaiting = defineFixture({
  width: 560,
  setup: () => stubHost(),
  render: () => (
    <InChat>
      <NativeChatWaitRow
        messageId="wait"
        automation={nora}
        once={{ by: deadline }}
        timestamp={Date.now()}
      />
    </InChat>
  )
})

export const chatCancelled = defineFixture({
  width: 560,
  setup: () =>
    stubHost({ ...ranger, cancelledWaits: [{ automationId: nora.id, at: today214am() }] }),
  render: () => (
    <InChat>
      <NativeChatWaitRow
        messageId="wait"
        automation={nora}
        once={{ by: deadline }}
        timestamp={Date.now()}
      />
    </InChat>
  )
})

export const chatEventCame = defineFixture({
  width: 560,
  render: () => (
    <InChat>
      <NativeChatWaitEndedRow
        messageId="ended"
        ended={{ automation: nora, ending: { kind: 'event', at: today214am(), actor: 'Nora' } }}
        timestamp={today214am()}
      />
    </InChat>
  )
})

export const chatDeadlineCame = defineFixture({
  width: 560,
  render: () => (
    <InChat>
      <NativeChatWaitEndedRow
        messageId="ended"
        ended={{ automation: nora, ending: { kind: 'deadline', at: deadline } }}
        timestamp={Date.now()}
      />
    </InChat>
  )
})

export const chatExpired = defineFixture({
  width: 560,
  render: () => (
    <InChat>
      <NativeChatWaitEndedRow
        messageId="ended"
        ended={{
          automation: { ...nora, name: 'Nora’s reply', once: {} },
          ending: { kind: 'expired', at: Date.now() }
        }}
        timestamp={Date.now()}
      />
    </InChat>
  )
})
