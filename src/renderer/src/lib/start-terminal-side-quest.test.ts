import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchSideQuest: vi.fn(),
  seedNativeChatSideQuestContext: vi.fn(),
  seedNativeChatSideQuestReadiness: vi.fn(),
  waitForAgentReady: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('./launch-side-quest', () => ({ launchSideQuest: mocks.launchSideQuest }))
vi.mock('@/components/native-chat/native-chat-side-quest-context-cache', () => ({
  seedNativeChatSideQuestContext: mocks.seedNativeChatSideQuestContext
}))
vi.mock('@/components/native-chat/native-chat-side-quest-readiness-cache', () => ({
  seedNativeChatSideQuestReadiness: mocks.seedNativeChatSideQuestReadiness
}))
vi.mock('./agent-ready-wait', () => ({
  waitForAgentReady: mocks.waitForAgentReady
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import { startTerminalSideQuest } from './start-terminal-side-quest'

describe('startTerminalSideQuest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.waitForAgentReady.mockResolvedValue({ ready: true, reason: 'title-idle' })
  })

  it('binds a cleaned selection to the new terminal tab', () => {
    mocks.launchSideQuest.mockReturnValue({
      status: 'started',
      groupId: 'side-group',
      terminalTabId: 'side-tab'
    })

    startTerminalSideQuest({
      worktreeId: 'worktree',
      sourceGroupId: 'source-group',
      agent: 'codex',
      capturedText: '\x1b[31mfailed\x1b[0m',
      sourceLabel: 'Tests'
    })

    mocks.launchSideQuest.mock.calls[0][0].beforeOpenChat?.('side-tab')
    expect(mocks.seedNativeChatSideQuestReadiness).toHaveBeenCalledWith(
      'side-tab',
      expect.any(Promise)
    )
    expect(mocks.waitForAgentReady).toHaveBeenCalledWith('side-tab', 'codex', {
      timeoutMs: 30_000
    })
    expect(mocks.seedNativeChatSideQuestContext).toHaveBeenCalledWith('side-tab', {
      sourceLabel: 'Tests',
      text: 'failed'
    })
  })

  it('starts a blank Side Quest without seeding quoted context', () => {
    mocks.launchSideQuest.mockReturnValue({
      status: 'started',
      groupId: 'side-group',
      terminalTabId: 'side-tab'
    })

    startTerminalSideQuest({
      worktreeId: 'worktree',
      sourceGroupId: 'source-group',
      agent: 'claude',
      capturedText: '',
      sourceLabel: 'Terminal'
    })

    mocks.launchSideQuest.mock.calls[0][0].beforeOpenChat?.('side-tab')
    expect(mocks.seedNativeChatSideQuestReadiness).toHaveBeenCalledWith(
      'side-tab',
      expect.any(Promise)
    )
    expect(mocks.seedNativeChatSideQuestContext).not.toHaveBeenCalled()
  })

  it('skips terminal readiness for provider transport while preserving quoted context', () => {
    mocks.launchSideQuest.mockReturnValue({
      status: 'started',
      groupId: 'side-group',
      terminalTabId: 'side-tab'
    })

    startTerminalSideQuest({
      worktreeId: 'worktree',
      sourceGroupId: 'source-group',
      agent: 'codex',
      capturedText: 'context',
      sourceLabel: 'Terminal'
    })

    mocks.launchSideQuest.mock.calls[0][0].beforeOpenChat?.('side-tab', 'provider')
    expect(mocks.seedNativeChatSideQuestReadiness).not.toHaveBeenCalled()
    expect(mocks.waitForAgentReady).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatSideQuestContext).toHaveBeenCalledWith('side-tab', {
      sourceLabel: 'Terminal',
      text: 'context'
    })
  })

  it('surfaces a specific runtime-host limitation', () => {
    mocks.launchSideQuest.mockReturnValue({ status: 'runtime-unsupported' })

    startTerminalSideQuest({
      worktreeId: 'worktree',
      sourceGroupId: 'source-group',
      agent: 'codex',
      capturedText: 'context',
      sourceLabel: 'Terminal'
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Side Quests are not available in runtime-hosted workspaces yet.'
    )
  })
})
