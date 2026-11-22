import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotGroup } from '../../../shared/bots/bot-group'

const mocks = vi.hoisted(() => {
  const groups: unknown[] = []
  return {
    open: vi.fn(async (_group: unknown, _roomId: string, _label: string) => {}),
    reveal: vi.fn(),
    groups
  }
})
vi.mock('./bot-group-catalog', () => ({ openBotGroupRoom: mocks.open }))
vi.mock('./bot-group-catalog-snapshot', () => ({ readBotGroups: () => mocks.groups }))
vi.mock('./agent-session/open/open-existing-structured-session', () => ({
  openDesktopStructuredSessionInteraction: mocks.reveal,
  revealStructuredSession: vi.fn()
}))

import { activateAiVaultStructuredSession } from './agent-session/open/activate-ai-vault-structured-session'

const group: BotGroup = {
  id: 'group-1',
  name: 'triage team',
  hostId: 'local',
  revision: 1,
  folder: 'group-triage',
  folderWorkspaceId: 'fw-g',
  createdAt: 1,
  replyMode: { kind: 'mentions' },
  members: [{ botId: 'a', sessionId: 'bot-group-member-a' }],
  threads: [
    {
      id: 'bot-group-thread-1',
      createdAt: 2,
      title: 'Release notes',
      members: [{ botId: 'a', sessionId: 'bot-group-member-ta' }]
    }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.groups = [group]
})

describe('activateAiVaultStructuredSession for a group member', () => {
  it("reopens a closed thread's room tab instead of the member's own chat", async () => {
    await activateAiVaultStructuredSession({
      structuredSession: { sessionId: 'bot-group-member-ta', workspaceId: 'fw-bot' }
    })
    expect(mocks.open).toHaveBeenCalledWith(group, 'bot-group-thread-1', 'Release notes')
    expect(mocks.reveal).not.toHaveBeenCalled()
  })

  it('opens any other native chat as before', async () => {
    mocks.reveal.mockResolvedValue({ kind: 'opened', target: { worktreeId: 'fw-bot' } })
    await activateAiVaultStructuredSession({
      structuredSession: { sessionId: 'bot-side-chat', workspaceId: 'fw-bot' }
    })
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.reveal).toHaveBeenCalledOnce()
  })
})
