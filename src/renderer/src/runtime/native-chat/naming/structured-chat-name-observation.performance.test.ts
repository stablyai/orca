import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import { makeStructuredChatTab, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { getStructuredChatTabNames } from './structured-chat-name-observation'

// Perf contract (tracked in #45759): every terminal title write re-resolved every chat's name,
// because the name snapshot was keyed on the whole tab map rather than the chat list.

let chatReads = 0
function counted<T extends object>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    Object.defineProperty(row, key, {
      enumerable: true,
      get: () => {
        chatReads++
        return value
      }
    })
  }
  return row
}

function workspaceTabs(worktreeId: string): Tab[] {
  return [
    makeUnifiedTab({ id: `t-${worktreeId}`, worktreeId, groupId: 'g' }),
    counted(
      makeStructuredChatTab({
        id: `c-${worktreeId}`,
        worktreeId,
        entityId: `session-${worktreeId}`
      })
    )
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
  const retitled = replaceTabBuckets(tabs, [
    [`wt-${workspaces}-0`, [{ ...terminal, label: 'vim' }, chat]]
  ])
  useAppStore.setState({ unifiedTabsByWorktree: retitled })
  // Advancing the shared chat list re-filters the replaced bucket; count name resolution alone.
  getStructuredAgentSessionTabs(retitled)
  chatReads = 0
  getStructuredChatTabNames()
  return chatReads
}

it('a terminal title write resolves no chat name, at N and 10N chats', () => {
  expect(chatReadsForTitleWrite(200)).toBe(0)
  expect(chatReadsForTitleWrite(2_000)).toBe(0)
})
