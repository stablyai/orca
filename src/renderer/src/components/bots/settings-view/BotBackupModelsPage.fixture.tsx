// Visual fixtures for bot backup models settings and transcript switch cards.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotBackupStatusResult } from '../../../../../shared/bots/bot-backup-models'
import { NativeChatBotBackupSwitchCard } from '../../native-chat/NativeChatBotBackupSwitchCard'
import { BotBackupModelsContent } from './BotBackupModelsPage'

const BASE_BOT: Bot = {
  id: 'bot-fixture-1',
  hostId: 'local',
  name: 'Release Scout',
  folder: 'release-scout',
  folderWorkspaceId: 'folder-fixture-1',
  avatar: null,
  paused: false,
  agent: 'claude',
  launch: { model: 'claude-sonnet-4-5' },
  backupModels: {
    automatic: true,
    order: [
      { agent: 'codex', model: 'gpt-5-codex' },
      { agent: 'claude', model: 'claude-haiku-4-5' }
    ]
  },
  activeBackup: {
    target: { agent: 'codex', model: 'gpt-5-codex' },
    switchedAt: 1_750_000_000_000,
    primaryModel: 'claude-sonnet-4-5',
    primaryResetsAt: 1_750_007_200_000
  },
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'session-fixture-1',
  createdAt: 1_750_000_000_000,
  updatedAt: 1_750_000_000_000
}

const ACTIVE_STATUS: BotBackupStatusResult = {
  botId: BASE_BOT.id,
  primary: {
    agent: 'claude',
    model: 'claude-sonnet-4-5',
    state: 'at-limit',
    resetsAt: 1_750_007_200_000
  },
  backupModels: BASE_BOT.backupModels ?? null,
  activeBackup: BASE_BOT.activeBackup ?? null,
  entries: [
    {
      entry: { agent: 'codex', model: 'gpt-5-codex' },
      state: 'ready'
    },
    {
      entry: { agent: 'claude', model: 'claude-haiku-4-5' },
      state: 'ready'
    }
  ],
  availableOptions: [
    { agent: 'claude', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', state: 'at-limit' },
    { agent: 'claude', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', state: 'ready' },
    {
      agent: 'codex',
      model: 'gpt-5-codex',
      label: 'GPT-5 Codex',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ],
      defaultEffort: 'medium',
      state: 'ready'
    },
    { agent: 'gemini', model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', state: 'ready' }
  ]
}

export const activeFailover = defineFixture({
  width: 680,
  render: () => (
    <div className="bg-background p-6">
      <BotBackupModelsContent
        bot={BASE_BOT}
        status={ACTIVE_STATUS}
        loading={false}
        returning={false}
        onSave={() => {}}
        onReturnNow={() => {}}
      />
    </div>
  )
})

export const empty = defineFixture({
  width: 680,
  render: () => (
    <div className="bg-background p-6">
      <BotBackupModelsContent
        bot={{ ...BASE_BOT, backupModels: undefined, activeBackup: undefined }}
        status={{
          ...ACTIVE_STATUS,
          primary: { agent: 'claude', model: 'claude-sonnet-4-5', state: 'ready' },
          backupModels: null,
          activeBackup: null,
          entries: []
        }}
        loading={false}
        returning={false}
        onSave={() => {}}
        onReturnNow={() => {}}
      />
    </div>
  )
})

export const switchCards = defineFixture({
  width: 560,
  render: () => (
    <div className="space-y-3 bg-background p-6">
      <NativeChatBotBackupSwitchCard
        switched={{
          switchId: 'switch-1',
          botId: BASE_BOT.id,
          direction: 'to-backup',
          fromAgent: 'claude',
          fromModel: 'claude-sonnet-4-5',
          toAgent: 'codex',
          toModel: 'gpt-5-codex',
          resetsAt: 1_750_007_200_000,
          at: 1_750_000_000_000
        }}
        timestamp={1_750_000_000_000}
      />
      <NativeChatBotBackupSwitchCard
        switched={{
          switchId: 'switch-2',
          botId: BASE_BOT.id,
          direction: 'to-primary',
          fromAgent: 'codex',
          fromModel: 'gpt-5-codex',
          toAgent: 'claude',
          toModel: 'claude-sonnet-4-5',
          at: 1_750_007_500_000
        }}
        timestamp={1_750_007_500_000}
      />
    </div>
  )
})
