// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'

const calls = vi.hoisted(() => ({
  start: vi.fn(async (_params: { botId: string; agent?: string }) => 'session-2'),
  newHomeChat: vi.fn(async (_botId: string) => 'home-2'),
  confirm: vi.fn(async (_options: { title: string }) => true),
  activate: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@/lib/bot-catalog', () => ({
  startBotSession: calls.start,
  newBotHomeChat: calls.newHomeChat
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => calls.confirm
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: calls.activate
}))
vi.mock('sonner', () => ({ toast: { error: calls.toast } }))

import { BotNewChatMenuItems } from './BotNewChatMenuItems'
import { botAgentChoices, botNewChatAgents } from '../../../../shared/bots/bot-agent-choices'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useAppStore.setState({ settings: null })
})

const bot: Bot = {
  id: 'bot-1',
  name: 'Reviewer',
  hostId: 'local',
  folder: 'reviewer',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: '🦉',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

function settled(
  rows: NewTabAgentMenuRow[],
  detectedIds: NewTabAgentMenuRow['agent'][] | null = []
) {
  return {
    state: 'settled',
    rows,
    detection: {
      detectedIds,
      isLoading: false,
      detectionFailed: false,
      isRefreshing: false,
      needsServerUpdate: false,
      refresh: async () => []
    }
  } satisfies NewTabAgentMenuModel
}

const BOTH = settled([
  { kind: 'chat', agent: 'codex' },
  { kind: 'chat', agent: 'claude' },
  { kind: 'chat', agent: 'gemini' }
])

function openMenu(model: NewTabAgentMenuModel = BOTH, forBot: Bot = bot): void {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>+</DropdownMenuTrigger>
      <DropdownMenuContent>
        <input aria-label="Search" />
        <BotNewChatMenuItems bot={forBot} model={model} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// The side chats, after New Home Chat.
const sideChats = () => screen.getAllByRole('menuitem').slice(1)

describe('BotNewChatMenuItems', () => {
  it("starts a chat with the bot on the chosen agent and opens its tab in the bot's home", async () => {
    openMenu()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))
    })

    expect(calls.start).toHaveBeenCalledWith(bot, { agent: 'codex' })
    await waitFor(() =>
      expect(calls.activate).toHaveBeenCalledWith({
        structuredSession: { workspaceId: 'folder:fw-1', sessionId: 'session-2' }
      })
    )
  })

  it('keeps the Home Chat on cancellation and opens a replacement after confirmation', async () => {
    calls.confirm.mockResolvedValueOnce(false)
    openMenu()
    const replaceHome = () =>
      act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /New Home Chat/ })))

    await replaceHome()
    expect(calls.confirm).toHaveBeenCalledOnce()
    expect(calls.newHomeChat).not.toHaveBeenCalled()
    expect(calls.activate).not.toHaveBeenCalled()

    await replaceHome()
    expect(calls.confirm).toHaveBeenCalledTimes(2)
    expect(calls.newHomeChat).toHaveBeenCalledWith(expect.objectContaining({ id: bot.id }))
    await waitFor(() =>
      expect(calls.activate).toHaveBeenCalledWith({
        structuredSession: { workspaceId: 'folder:fw-1', sessionId: 'home-2' }
      })
    )
  })

  it('starts without asking once the owner said not to ask again', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/home/user'), skipNewHomeChatConfirm: true }
    })
    openMenu()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /New Home Chat/ }))
    })

    expect(calls.confirm).not.toHaveBeenCalled()
    expect(calls.newHomeChat).toHaveBeenCalledWith(expect.objectContaining({ id: bot.id }))
  })

  it('says why when the chat cannot start', async () => {
    calls.start.mockRejectedValueOnce(new Error('bot_not_found'))
    openMenu()

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Claude Code/ }))
    })

    await waitFor(() => expect(calls.toast).toHaveBeenCalled())
    expect(calls.activate).not.toHaveBeenCalled()
  })

  it('shows an agent that cannot start as the agent rows do', () => {
    openMenu(settled([{ kind: 'chat', agent: 'codex' }], ['codex']))

    const own = screen.getByRole('menuitem', { name: /Claude Code/ })
    expect(own.getAttribute('aria-disabled')).toBe('true')
    expect(own.textContent).toContain('Not installed')
    expect(screen.getByRole('menuitem', { name: /Codex/ }).getAttribute('aria-disabled')).toBeNull()
  })

  it('sends typing to the search field, and leaves Space to choose the item', () => {
    openMenu()
    const own = sideChats()[0]!
    act(() => own.focus())
    expect(document.activeElement).toBe(own)

    fireEvent.keyDown(own, { key: ' ' })
    expect(document.activeElement).toBe(own)
    fireEvent.keyDown(own, { key: 'r' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search' }))
  })
})

describe('botNewChatAgents', () => {
  it("carries the host's reason for an unavailable chat, and a failed check for a missing row", () => {
    expect(
      botNewChatAgents(
        bot,
        settled([{ kind: 'chat-unavailable', agent: 'claude', reason: 'ssh' }], null)
      )
    ).toEqual(
      expect.arrayContaining([
        { agent: 'claude', unavailable: 'ssh' },
        { agent: 'codex', unavailable: 'check-failed' }
      ])
    )
  })

  it('counts a terminal-only row as startable, since a bot chat does not need the chat setting', () => {
    expect(botNewChatAgents(bot, settled([{ kind: 'terminal', agent: 'claude' }]))).toEqual([
      { agent: 'claude' }
    ])
  })

  it('keeps the bot’s own agent before and after discovering other installed agents', () => {
    const current = { agent: 'opencode' } as const
    expect(botNewChatAgents(current, { state: 'loading' })).toEqual([{ agent: 'opencode' }])
    const model = settled([
      { kind: 'chat', agent: 'grok' },
      { kind: 'chat', agent: 'omp' }
    ])
    expect(botNewChatAgents(current, model)).toEqual([
      { agent: 'opencode', unavailable: 'not-installed' },
      { agent: 'grok' },
      { agent: 'omp' }
    ])
  })
})

describe('botAgentChoices', () => {
  const model = settled([
    { kind: 'chat', agent: 'codex' },
    { kind: 'chat', agent: 'opencode' },
    { kind: 'chat', agent: 'opencode2' }
  ])

  it('keeps the bot’s current agent even when this computer lacks it', () => {
    expect(botAgentChoices(model, 'omp')).toEqual(['codex', 'opencode', 'omp'])
  })

  it('offers agents with chat regardless of their default surface', () => {
    const rows = settled([
      { kind: 'terminal', agent: 'claude' },
      { kind: 'cli', agent: 'codex', chat: true },
      { kind: 'chat-unavailable', agent: 'grok', reason: 'windows' }
    ])
    expect(botAgentChoices(rows)).toEqual(['codex'])
  })

  it('has only the current agent while the host is unknown', () => {
    expect(botAgentChoices({ state: 'loading' }, 'grok')).toEqual(['grok'])
    expect(botAgentChoices({ state: 'loading' })).toEqual([])
  })
})
