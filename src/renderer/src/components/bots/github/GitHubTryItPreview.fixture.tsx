import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import { GitHubTryItPreview } from './GitHubTryItPreview'

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
const longName: Bot = {
  ...triage,
  name: 'Orchestration builder for the whole engineering team',
  folder: 'orchestration-builder'
}
const longLogin = 'dana-lee-from-the-platform-infrastructure-team'

// 464: the GitHub setup dialog's content at its desktop width. 327: a phone-width bottom sheet.
// No user id: the asker shows as initials, never a real person's picture.
export const desktop = defineFixture({
  width: 464,
  render: () => <GitHubTryItPreview bot={triage} login="dana" userId={null} />
})
export const desktopLongName = defineFixture({
  width: 464,
  render: () => <GitHubTryItPreview bot={longName} login={longLogin} userId={null} />
})
export const phone = defineFixture({
  width: 327,
  render: () => <GitHubTryItPreview bot={triage} login="dana" userId={null} />
})
export const phoneLongName = defineFixture({
  width: 327,
  render: () => <GitHubTryItPreview bot={longName} login={longLogin} userId={null} />
})
