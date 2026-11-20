// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'

const bot: Bot = {
  id: 'b1',
  name: 'Juno',
  hostId: 'local',
  folder: 'juno',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'chat-1',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const mocks = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ retried: true })) }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./bot-workspace', () => ({ useBotForWorkspace: () => bot }))
vi.mock('../native-chat/media/visuals/native-chat-visual-owner', () => ({
  useNativeChatVisualOwner: () => ({ worktreeId: 'folder:fw-1' })
}))

import { BotFirstScreen } from './BotFirstScreen'

describe('a new bot’s first screen', () => {
  it('offers Try again when its first turn ended without a word', () => {
    render(
      <BotFirstScreen
        firstScreen={{
          phase: 'failed',
          turn: [
            {
              id: 'm',
              role: 'assistant',
              blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'pwd' } }],
              timestamp: null,
              source: 'transcript'
            }
          ],
          refused: null
        }}
        isVisible
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.kickoff.retry', {
      botId: 'b1'
    })
  })
})
