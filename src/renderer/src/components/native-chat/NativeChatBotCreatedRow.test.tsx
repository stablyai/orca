// @vitest-environment happy-dom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  NativeChatBotKickoffContext,
  type NativeChatBotKickoffView
} from './native-chat-bot-kickoff-view'

vi.mock('@/components/bots/bot-workspace', () => ({
  useBotForWorkspace: () => ({ id: 'b1', name: 'Juno', agent: 'claude', avatar: null })
}))
vi.mock('@/components/bots/bot-chat-persona', () => ({ useBotDescription: () => null }))
vi.mock('./media/visuals/native-chat-visual-owner', () => ({
  useNativeChatVisualOwner: () => ({ worktreeId: 'folder:fw-1' })
}))

import { NativeChatBotCreatedRow } from './NativeChatBotCreatedRow'

const view: NativeChatBotKickoffView = {
  live: true,
  bot: null,
  firstScreen: null,
  firstKickoffId: 'k1',
  send: async () => true,
  sendBlockedReason: () => undefined
}

describe('the kickoff row in a bot’s Home', () => {
  it('is the bot’s header at its first kickoff, and a quiet line at a Try again', () => {
    render(
      <NativeChatBotKickoffContext.Provider value={view}>
        <NativeChatBotCreatedRow messageId="k1" timestamp={null} />
        <NativeChatBotCreatedRow messageId="k2" timestamp={null} />
      </NativeChatBotKickoffContext.Provider>
    )
    expect(screen.getByText('Juno')).toBeTruthy()
    expect(screen.getByText('Your new bot · runs your Claude Code')).toBeTruthy()
    expect(screen.getAllByText('Juno started setting up again').length).toBeGreaterThan(0)
  })
})
