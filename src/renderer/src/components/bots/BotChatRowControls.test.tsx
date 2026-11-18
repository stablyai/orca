// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Tab, TabGroup } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { pressFoldableRow } from '../../../../shared/bots/bot-row-press'
import { useBotChatPress } from './BotChatRowControls'

const bot = { hostId: 'local', id: 'bot-1', folderWorkspaceId: 'home-1' } as const
const workspaceId = 'folder:home-1'

function showChatTab(chatId: string | null): void {
  const tabs: Tab[] = chatId
    ? [
        {
          id: `structured-agent-session-${chatId}`,
          entityId: chatId,
          groupId: 'group-1',
          worktreeId: workspaceId,
          contentType: 'agent-session',
          label: 'Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    : []
  const group: TabGroup = {
    id: 'group-1',
    worktreeId: workspaceId,
    activeTabId: tabs[0]?.id ?? null,
    tabOrder: tabs.map((tab) => tab.id),
    recentTabIds: []
  }
  useAppStore.setState({
    activeView: 'terminal',
    activeWorkspaceKey: workspaceId,
    activeGroupIdByWorktree: { [workspaceId]: 'group-1' },
    groupsByWorktree: { [workspaceId]: [group] },
    unifiedTabsByWorktree: { [workspaceId]: tabs }
  })
}

function ChatRow({ chatId, onOpen }: { chatId: string; onOpen: () => void }): React.JSX.Element {
  const fold = useAppStore((s) => s.botChatFold(bot.hostId, bot.id, chatId))
  const { active, toggle } = useBotChatPress(bot, chatId)
  const open = fold === 'open'
  const press = (event: { detail: number }): void =>
    pressFoldableRow({ active, folded: !open, open: onOpen, toggle: () => toggle(open) }, event)
  return (
    <div
      role="button"
      tabIndex={0}
      data-fold={fold}
      onClick={press}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          press(event)
        }
      }}
    >
      row
    </div>
  )
}

function foldOf(chatId: string): string | undefined {
  return useAppStore.getState().botChatFold(bot.hostId, bot.id, chatId)
}

beforeEach(() => {
  vi.stubGlobal('api', { ui: { set: vi.fn(async () => undefined) } })
  useAppStore.setState({ botChatFolds: {} })
  useAppStore.getState().setBotChatFold(bot.hostId, bot.id, 'chat-1', 'folded')
  showChatTab(null)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The press rule itself is tested with it in src/shared/bots/bot-row-press.test.ts; these check
// that a chat counts as the open one only while its tab is in front.
describe('clicking a bot chat row', () => {
  it('toggles the fold when the chat is already the tab in front', () => {
    const onOpen = vi.fn()
    useAppStore.getState().setBotChatFold(bot.hostId, bot.id, 'chat-1', 'open')
    showChatTab('chat-1')
    render(<ChatRow chatId="chat-1" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'), { detail: 1 })
    expect(foldOf('chat-1')).toBe('folded')
    fireEvent.click(screen.getByRole('button'), { detail: 1 })
    expect(foldOf('chat-1')).toBe('open')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('opens rather than folds when another chat is in front', () => {
    const onOpen = vi.fn()
    useAppStore.getState().setBotChatFold(bot.hostId, bot.id, 'chat-1', 'open')
    showChatTab('chat-2')
    render(<ChatRow chatId="chat-1" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button'), { detail: 1 })
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(foldOf('chat-1')).toBe('open')
  })
})
