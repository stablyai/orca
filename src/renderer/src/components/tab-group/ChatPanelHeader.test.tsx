// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { TooltipProvider } from '../ui/tooltip'
import { requestTerminalTabRenameWhenMounted } from '../tab-bar/terminal-tabs/terminal-tab-rename-request'
import { ChatPanelHeader } from './ChatPanelHeader'

const state = vi.hoisted(() => ({
  settings: { tabAutoGenerateTitle: false },
  setTabCustomTitle: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))

const chat: Tab = {
  id: 'chat-1',
  entityId: 'session-1',
  groupId: 'chat-group',
  worktreeId: 'workspace',
  contentType: 'agent-session',
  agentSessionAgent: 'claude',
  label: 'Fix build errors',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('fixed chat panel header', () => {
  it('does not show a different provider icon when the agent is unknown', () => {
    const { container } = render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[{ ...chat, agentSessionAgent: 'future-agent' }]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(
      container.querySelector('[data-chat-panel-header] > [data-agent-icon]')?.textContent
    ).toBe('?')
  })
  it.each(['claude', 'codex', 'opencode'] as const)(
    'uses the existing %s provider icon in the header',
    (agent) => {
      const { container } = render(
        <TooltipProvider>
          <ChatPanelHeader
            worktreeId="workspace"
            groupId="chat-group"
            chats={[{ ...chat, agentSessionAgent: agent }]}
            activeTabId={chat.id}
            onActivate={vi.fn()}
            onClose={vi.fn()}
          />
        </TooltipProvider>
      )
      expect(
        container.querySelector(`[data-chat-panel-header] > [data-agent-icon="${agent}"] svg`)
      ).toBeTruthy()
      expect(container.querySelector('.lucide-message-square')).toBeNull()
    }
  )

  it('updates the provider icon when the active conversation changes', async () => {
    const chats = [
      chat,
      { ...chat, id: 'chat-2', label: 'Review changes', agentSessionAgent: 'codex' as const }
    ]
    const props = {
      chats,
      onActivate: vi.fn(),
      onClose: vi.fn()
    }
    const view = render(
      <TooltipProvider>
        <ChatPanelHeader
          {...props}
          worktreeId="workspace"
          groupId="chat-group"
          activeTabId={chat.id}
        />
      </TooltipProvider>
    )
    expect(
      view.container.querySelector('[data-chat-panel-header] > [data-agent-icon="claude"]')
    ).toBeTruthy()
    expect(
      screen.getByRole('tab', { name: 'Review changes' }).querySelector('[data-agent-icon="codex"]')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Review changes' }))
    expect(props.onActivate).toHaveBeenCalledWith('chat-2')
    view.rerender(
      <TooltipProvider>
        <ChatPanelHeader
          {...props}
          worktreeId="workspace"
          groupId="chat-group"
          activeTabId="chat-2"
        />
      </TooltipProvider>
    )
    expect(
      view.container.querySelector('[data-chat-panel-header] > [data-agent-icon="codex"] svg')
    ).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Review changes' }).getAttribute('aria-selected')).toBe(
      'true'
    )
  })

  it('shows the conversation title instead of a tab, with only a close action', () => {
    const close = vi.fn()
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={close}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Fix build errors')).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore chat tab bar' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Dock chat panel' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }))
    expect(close).toHaveBeenCalledWith(chat.id)
  })

  it('keeps actions clear of fixed window controls when requested', () => {
    const { container } = render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={vi.fn()}
          insetWindowControls
        />
      </TooltipProvider>
    )
    const header = container.querySelector('[data-chat-panel-header]')
    expect(header?.getAttribute('style')).toContain(
      'padding-right: var(--window-controls-width, 0px)'
    )
  })

  it('lets the reader switch conversations without a chat tab strip', async () => {
    const activate = vi.fn()
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat, { ...chat, id: 'chat-2', label: 'Review changes' }]}
          activeTabId={chat.id}
          onActivate={activate}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )
    fireEvent.click(await screen.findByRole('tab', { name: 'Review changes' }))
    expect(activate).toHaveBeenCalledWith('chat-2')
  })

  it('renames the active conversation from the header', () => {
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }))
    const input = screen.getByRole('textbox', { name: 'Rename chat' })
    fireEvent.change(input, { target: { value: 'Release notes' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(state.setTabCustomTitle).toHaveBeenCalledWith(chat.id, 'Release notes')
    expect(screen.queryByRole('textbox', { name: 'Rename chat' })).toBeNull()
  })

  it('opens the rename editor when a launch requested it before the header mounted', async () => {
    requestTerminalTabRenameWhenMounted(chat.id)
    render(
      <TooltipProvider>
        <ChatPanelHeader
          worktreeId="workspace"
          groupId="chat-group"
          chats={[chat]}
          activeTabId={chat.id}
          onActivate={vi.fn()}
          onClose={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(await screen.findByRole('textbox', { name: 'Rename chat' })).toBeTruthy()
  })
})
