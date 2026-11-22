// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { SlackTryItPreview } from './SlackTryItPreview'

afterEach(cleanup)

const bot = (name: string): Bot => ({
  id: 'bot-1',
  name,
  hostId: 'local',
  folder: 'ops',
  folderWorkspaceId: 'fw-1',
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
})

describe('SlackTryItPreview', () => {
  it('shows a markup-shaped bot name as text in the mention', () => {
    const { container } = render(<SlackTryItPreview bot={bot('Ops <i>EU</i>')} asker="Dana" />)
    const mention = screen.getByTitle('@Ops <i>EU</i>')
    expect(mention.textContent).toBe('@Ops <i>EU</i>')
    expect(mention.closest('p')?.textContent).toBe('@Ops <i>EU</i> summarize this thread')
    expect(container.querySelector('i')).toBeNull()
  })
})
