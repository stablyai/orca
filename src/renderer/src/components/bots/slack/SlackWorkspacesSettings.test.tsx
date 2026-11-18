// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { SlackWorkspacesSettings } from './SlackWorkspacesSettings'

const bot: Bot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T05' },
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

vi.mock('@/lib/bot-catalog', () => ({ useHostBots: () => [bot], useBots: () => [bot] }))

const installed: ConnectorBotSlackState = {
  state: 'installed',
  teamId: 'T05',
  appId: 'A1',
  botUserId: 'UB',
  installerUserId: 'U07'
}

function renderWith(slack: ConnectorBotSlackState): void {
  Object.assign(window, {
    api: withBotConnectorRuntime({
      botSlack: { state: vi.fn().mockResolvedValue({ ok: true, value: slack }) }
    })
  })
  render(<SlackWorkspacesSettings hostId="local" botHostIds={['local']} account={null} />)
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

describe('SlackWorkspacesSettings', () => {
  it('names each workspace as Slack shows it', async () => {
    renderWith({ ...installed, teamName: 'Globex' })
    expect(await screen.findByText('Globex')).toBeDefined()
    expect(screen.getByText('Scout')).toBeDefined()
  })

  it('falls back to the id when the cloud has no name', async () => {
    renderWith(installed)
    expect(await screen.findByText('T05')).toBeDefined()
  })
})
