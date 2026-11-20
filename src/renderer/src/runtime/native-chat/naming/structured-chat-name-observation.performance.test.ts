import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { getStructuredChatTabNames } from './structured-chat-name-observation'

// Perf contract (tracked in #45759): every terminal title write re-resolved every chat's name,
// because the name snapshot was keyed on the whole tab map rather than the chat list.

let chatReads = 0
function counted(tab: Tab): Tab {
  return new Proxy(tab, {
    get(target, key, receiver) {
      chatReads++
      return Reflect.get(target, key, receiver)
    }
  })
}

function workspaceTabs(worktreeId: string): Tab[] {
  const base = { groupId: 'g', worktreeId, customLabel: null, color: null, createdAt: 1 }
  return [
    {
      ...base,
      id: `t-${worktreeId}`,
      entityId: `term-${worktreeId}`,
      contentType: 'terminal',
      label: 'shell',
      sortOrder: 0
    },
    counted({
      ...base,
      id: `c-${worktreeId}`,
      entityId: `session-${worktreeId}`,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Chat',
      sortOrder: 1
    })
  ]
}

function chatReadsForTitleWrite(workspaces: number): number {
  const tabs: Record<string, Tab[]> = {}
  for (let index = 0; index < workspaces; index++) {
    tabs[`wt-${workspaces}-${index}`] = workspaceTabs(`wt-${workspaces}-${index}`)
  }
  useAppStore.setState({ unifiedTabsByWorktree: tabs })
  expect(getStructuredChatTabNames().size).toBe(workspaces)
  const [terminal, chat] = tabs[`wt-${workspaces}-0`]
  useAppStore.setState({
    unifiedTabsByWorktree: replaceTabBuckets(tabs, [
      [`wt-${workspaces}-0`, [{ ...terminal, label: 'vim' }, chat]]
    ])
  })
  chatReads = 0
  getStructuredChatTabNames()
  return chatReads
}

it('a terminal title write resolves no chat name, at N and 10N chats', () => {
  expect(chatReadsForTitleWrite(200)).toBe(0)
  expect(chatReadsForTitleWrite(2_000)).toBe(0)
})
