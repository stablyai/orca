import { expect, it } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { advanceActivityTabs, type ActivityTabProjection } from './activity-tab-projection'
import {
  createActivityEventBuildCache,
  resolveActivityTabIndexes
} from './activity-event-build-cache'

// Perf contract (tracked in #45759): a terminal title write replaced every workspace's tab
// buckets in the Activity projection and rebuilt its tab context and host indexes over the fleet.

let reads = 0
function counted<T extends object>(row: T): T {
  return new Proxy(row, {
    get(target, key, receiver) {
      reads++
      return Reflect.get(target, key, receiver)
    }
  })
}

function terminal(worktreeId: string, title: string): TerminalTab {
  return counted({
    id: `term-${worktreeId}`,
    ptyId: `pty-${worktreeId}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
}

function unified(worktreeId: string, label: string): Tab[] {
  const base = { groupId: 'g', worktreeId, customLabel: null, color: null, createdAt: 1 }
  return [
    counted({
      ...base,
      id: `unified-${worktreeId}`,
      entityId: `term-${worktreeId}`,
      contentType: 'terminal',
      label,
      sortOrder: 0,
      executionHostId: 'local'
    }),
    counted({
      ...base,
      id: `chat-${worktreeId}`,
      entityId: `session-${worktreeId}`,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Chat',
      sortOrder: 1
    })
  ]
}

function tabReadsForTitleWrite(workspaces: number): number {
  const names: StructuredChatTabNames = new Map()
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  for (let index = 0; index < workspaces; index++) {
    tabsByWorktree[`wt-${index}`] = [terminal(`wt-${index}`, 'shell')]
    unifiedTabsByWorktree[`wt-${index}`] = unified(`wt-${index}`, 'shell')
  }
  const cache = createActivityEventBuildCache()
  const projected: ActivityTabProjection = advanceActivityTabs(unifiedTabsByWorktree, null, null)
  resolveActivityTabIndexes(
    { tabsByWorktree, unifiedTabsByWorktree: projected, chatNames: names },
    cache
  )

  const nextTabs = replaceTabBuckets(tabsByWorktree, [['wt-0', [terminal('wt-0', 'vim')]]])
  const nextUnified = replaceTabBuckets(unifiedTabsByWorktree, [['wt-0', unified('wt-0', 'vim')]])
  reads = 0
  const nextProjected = advanceActivityTabs(nextUnified, unifiedTabsByWorktree, projected)
  const indexes = resolveActivityTabIndexes(
    { tabsByWorktree: nextTabs, unifiedTabsByWorktree: nextProjected, chatNames: names },
    cache
  )
  const count = reads
  expect(indexes.context.get('term-wt-0')?.tab.title).toBe('vim')
  return count
}

it('a terminal title write reads only its own workspace tabs, at N and 10N workspaces', () => {
  expect(tabReadsForTitleWrite(200)).toBeLessThan(100)
  expect(tabReadsForTitleWrite(2000)).toBeLessThan(100)
})
