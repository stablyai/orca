// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'

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

function turn(blocks: NativeChatBlock[]): NativeChatMessage[] {
  return [{ id: 'm', role: 'assistant', blocks, timestamp: null, source: 'transcript' }]
}

const repoList: NativeChatBlock[] = [
  { type: 'tool-call', name: 'Bash', callId: '1', input: { command: 'orca repo list --json' } },
  {
    type: 'tool-result',
    callId: '1',
    output: JSON.stringify({
      result: { repos: [{ displayName: 'orca' }, { displayName: 'relay' }] }
    })
  }
]
const linearRead: NativeChatBlock = {
  type: 'tool-call',
  name: 'Bash',
  callId: '2',
  input: { command: 'orca linear list-issues --assignee me --json' }
}

describe('a new bot’s first screen', () => {
  it('says who it is and lists what it finds as it reads', () => {
    render(
      <BotFirstScreen
        firstScreen={{ phase: 'starting', turn: turn([...repoList, linearRead]), refused: null }}
        isVisible
      />
    )
    expect(screen.getByText('Juno')).toBeTruthy()
    expect(screen.getByText('Your new bot · runs your Claude Code')).toBeTruthy()
    expect(screen.getByText('Getting to know your setup…')).toBeTruthy()
    expect(screen.getByText('Found 2 projects: orca, relay')).toBeTruthy()
    expect(screen.getByText('Linear: reading your open issues…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('offers Try again when its first turn ended without a word', () => {
    render(
      <BotFirstScreen
        firstScreen={{ phase: 'failed', turn: turn([...repoList, linearRead]), refused: null }}
        isVisible
      />
    )
    expect(screen.getByText('Couldn’t finish setting up')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.kickoff.retry', {
      botId: 'b1'
    })
  })
})
