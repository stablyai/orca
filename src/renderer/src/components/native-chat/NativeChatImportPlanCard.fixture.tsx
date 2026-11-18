import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type { BotOfferAnswer } from '../../../../shared/bots/bot-offer-answers'
import type { BotImportPlan } from '../../../../shared/bots/bot-import-cards'
import { NativeChatImportPlanCard } from './NativeChatImportPlanCard'

const atlas: Bot = {
  id: 'bot-atlas',
  name: 'Atlas',
  hostId: 'local',
  folder: 'atlas',
  folderWorkspaceId: 'fw-atlas',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const plan: BotImportPlan = {
  botId: atlas.id,
  app: 'Molty',
  name: 'Molty',
  items: [
    { group: 'comes', what: 'Who Molty is', to: 'Soul', why: 'Its voice and how it talks to you.' },
    { group: 'changed', what: '3 schedules', to: 'paused automations', why: 'They start paused.' },
    { group: 'already', what: 'GitHub', why: 'Already connected here.' },
    { group: 'stays', what: 'Saved logins', why: 'Keys and logins are never copied.' }
  ]
}

function answered(answer?: Omit<BotOfferAnswer, 'cardId'>): () => void {
  return () =>
    stubBots([answer ? { ...atlas, offerAnswers: [{ cardId: 'plan', ...answer }] } : atlas])
}

function Plan(): React.JSX.Element {
  return (
    <div className="p-4">
      <NativeChatImportPlanCard plan={plan} messageId="plan" />
    </div>
  )
}

export const offered = defineFixture({ width: 640, setup: answered(), render: () => <Plan /> })

export const notNow = defineFixture({
  width: 640,
  setup: answered({ dismissed: true }),
  render: () => <Plan />
})

// The owner left the schedules out.
export const imported = defineFixture({
  width: 640,
  setup: answered({ sent: { chosen: ['0'] } }),
  render: () => <Plan />
})
