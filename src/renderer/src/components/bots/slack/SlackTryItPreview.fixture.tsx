import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { SlackTryItPreview } from './SlackTryItPreview'

const triage: Bot = {
  id: 'bot-triage',
  name: 'Triage bot',
  hostId: 'local',
  folder: 'triage',
  folderWorkspaceId: 'fw-triage',
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
const longName: Bot = { ...triage, name: 'Orchestration builder for the whole engineering team' }

// 464: the Slack setup dialog's content at its desktop width. 327: a phone-width bottom sheet.
export const desktop = defineFixture({
  width: 464,
  render: () => <SlackTryItPreview bot={triage} asker="Dana Lee" />
})
export const desktopLongName = defineFixture({
  width: 464,
  render: () => <SlackTryItPreview bot={longName} asker="Dana Lee" />
})
export const phoneLongName = defineFixture({
  width: 327,
  render: () => <SlackTryItPreview bot={longName} asker="Dana Lee" />
})
// An older cloud leaves out who installed it.
export const noInstallerName = defineFixture({
  width: 327,
  render: () => <SlackTryItPreview bot={triage} asker={undefined} />
})
