import { expect, it } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  closedWorkspaceChat,
  closedWorkspaceChats,
  workspaceChatHasConversation
} from './closed-workspace-chat'
import type { WorkspaceChat } from './workspace-chats'

const tab: Tab = {
  id: 'chat-tab',
  entityId: 'session-one',
  worktreeId: 'workspace-one',
  groupId: 'group',
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  executionHostId: 'local',
  label: 'Navigation changes',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

it('retains a saved chat by workspace and owning host independently of its tab identity', () => {
  expect(closedWorkspaceChat(tab, 'local', false, true)).toEqual({
    workspaceId: 'workspace-one',
    executionHostId: 'local',
    sessionId: 'session-one',
    agent: 'codex',
    title: 'Navigation changes'
  })
})

it('omits empty, provisional, non-chat and ownerless tabs', () => {
  expect(closedWorkspaceChat(tab, 'local', false, false)).toBeNull()
  expect(closedWorkspaceChat(tab, 'local', true, true)).toBeNull()
  expect(closedWorkspaceChat({ ...tab, contentType: 'editor' }, 'local', false, true)).toBeNull()
  expect(closedWorkspaceChat(tab, null, false, true)).toBeNull()
})

it('retains unread and loading saved chats while omitting confirmed empty conversations', () => {
  expect(
    closedWorkspaceChat(tab, 'local', false, workspaceChatHasConversation(undefined, false))
  ).toEqual(expect.objectContaining({ sessionId: 'session-one' }))
  expect(
    closedWorkspaceChat(
      tab,
      'local',
      false,
      workspaceChatHasConversation(
        {
          status: 'loading',
          items: [],
          submissions: [],
          hasOlder: false
        },
        false
      )
    )
  ).toEqual(expect.objectContaining({ sessionId: 'session-one' }))
  expect(
    closedWorkspaceChat(
      tab,
      'local',
      false,
      workspaceChatHasConversation(
        {
          status: 'ready',
          items: [],
          submissions: [],
          hasOlder: false
        },
        false,
        true
      )
    )
  ).toBeNull()
  expect(
    closedWorkspaceChat(
      tab,
      'local',
      false,
      workspaceChatHasConversation(
        {
          status: 'ready',
          items: [],
          submissions: [],
          hasOlder: false
        },
        true
      )
    )
  ).toEqual(expect.objectContaining({ sessionId: 'session-one' }))
})

it('keeps a previously empty chat when its reader is stale', () => {
  const evidence = workspaceChatHasConversation(
    {
      status: 'ready',
      items: [],
      submissions: [],
      hasOlder: false
    },
    false,
    false
  )
  expect(closedWorkspaceChat(tab, 'local', false, evidence)).toEqual(
    expect.objectContaining({ sessionId: 'session-one' })
  )
})

it('shows closed chats only in their owning workspace and host, without open duplicates', () => {
  const chats: WorkspaceChat[] = [
    {
      workspaceId: 'workspace-one',
      executionHostId: 'local',
      sessionId: 'session-one',
      agent: 'codex',
      title: 'First'
    },
    {
      workspaceId: 'workspace-one',
      executionHostId: 'local',
      sessionId: 'session-two',
      agent: 'codex',
      title: 'Second'
    },
    {
      workspaceId: 'workspace-two',
      executionHostId: 'local',
      sessionId: 'session-two',
      agent: 'codex',
      title: 'Another workspace'
    },
    {
      workspaceId: 'workspace-one',
      executionHostId: 'runtime:remote',
      sessionId: 'session-two',
      agent: 'codex',
      title: 'Another host'
    }
  ]
  expect(closedWorkspaceChats(chats, 'workspace-one', 'local', [tab])).toEqual([chats[1]])
  expect(closedWorkspaceChats(chats, 'workspace-one', null, [])).toEqual([])
})
