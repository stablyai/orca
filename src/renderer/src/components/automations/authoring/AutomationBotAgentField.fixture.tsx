import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import { AutomationBotTargetFields } from './AutomationBotTargetFields'
import { AutomationBotAgentField } from './AutomationBotAgentField'

const bot: Bot = {
  id: 'bot-performance',
  name: 'Performance',
  hostId: 'local',
  folder: 'performance',
  folderWorkspaceId: 'fw-performance',
  agent: 'claude',
  launch: { model: 'opus' },
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
const base: AutomationBotTarget = { botId: bot.id, runsIn: 'new', resultsTo: 'chat' }

/** The bot automation form as the editor's sidebar shows it: Runs in, Agent, Send results to. */
function Form({ target, withAgent = true }: { target: AutomationBotTarget; withAgent?: boolean }) {
  return (
    <aside className="w-[320px] border-l border-border/50 bg-muted/20 px-5 py-5">
      <AutomationBotTargetFields
        target={target}
        bot={bot}
        threadReplies
        hasEventThread={false}
        agentField={
          withAgent ? (
            <AutomationBotAgentField target={target} bot={bot} onChange={() => {}} />
          ) : null
        }
        onChange={() => {}}
      />
    </aside>
  )
}

export const before = defineFixture({
  width: 340,
  render: () => <Form target={base} withAgent={false} />
})
export const sameAsBot = defineFixture({ width: 340, render: () => <Form target={base} /> })
export const ownAgent = defineFixture({
  width: 340,
  render: () => (
    <Form
      target={{
        ...base,
        agentSetup: { agent: 'codex', launch: { model: 'gpt-5.5', options: { effort: 'high' } } }
      }}
    />
  )
})
export const inChat = defineFixture({
  width: 340,
  render: () => <Form target={{ ...base, runsIn: 'chat' }} />
})
export const menuOpen = defineFixture({
  width: 340,
  render: () => <Form target={base} />,
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('[data-agent-launch-picker-trigger]')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
