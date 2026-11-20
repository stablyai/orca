import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { BotSlackSetupDialog } from './BotSlackSetupDialog'
import { BotSlackCard } from './BotSlackCard'

const bot: Bot = {
  id: 'bot-slack-removal',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-scout',
  agent: 'codex',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

function stub(slack: ConnectorBotSlackState): void {
  publishBots([bot])
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    call: async ({ method }: { method: string }) => {
      if (method === 'bots.list') {
        return { ok: true, result: { bots: [bot] } }
      }
      if (method === 'bots.slack.state') {
        return { ok: true, result: { ok: true, value: slack } }
      }
      return { ok: false, error: { code: 'fixture', message: method } }
    }
  })
}

export const unfinishedSetup = defineFixture({
  width: 1100,
  setup: () => stub({ state: 'created', teamId: 'T1', appId: 'A1' }),
  render: () => (
    <ConfirmationDialogProvider>
      <BotSlackSetupDialog bot={bot} teamId="T1" open onOpenChange={() => {}} />
    </ConfirmationDialogProvider>
  )
})

export const missingApp = defineFixture({
  width: 720,
  setup: () => stub({ state: 'not_created' }),
  render: () => (
    <ConfirmationDialogProvider>
      <BotSlackCard bot={bot} teamId="T1" defaultOpen />
    </ConfirmationDialogProvider>
  )
})
