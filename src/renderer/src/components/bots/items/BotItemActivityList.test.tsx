// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { BotItemActivityList } from './BotItemActivityList'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

afterEach(cleanup)

it('renders a comment as Markdown, never the raw source', () => {
  const { container } = render(
    <BotItemActivityList
      bot={BOT}
      item={makeTestBotItem(6)}
      events={[
        {
          id: 'e2',
          kind: 'commented',
          actor: { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' },
          data: { text: '**What pause does today**\n\n- Automations: skipped\n- Look around: off' },
          at: 100
        }
      ]}
      onReply={() => {}}
    />
  )

  expect(screen.getByText('What pause does today').tagName).toBe('STRONG')
  expect(container.querySelectorAll('li')).toHaveLength(2)
  expect(container.textContent).not.toContain('**')
})
