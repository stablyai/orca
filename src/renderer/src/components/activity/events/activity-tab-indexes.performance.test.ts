import { expect, it } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { StructuredChatTabNames } from '@/runtime/native-chat/naming/structured-chat-tab-name'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { makeStructuredChatTab, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeTerminalTab } from '@/store/terminals/testing/terminal-row.test-fixture'
import { advanceActivityTabs, type ActivityTabProjection } from './activity-tab-projection'
import {
  createActivityEventBuildCache,
  resolveActivityTabIndexes
} from './activity-event-build-cache'

// Perf contract (tracked in #45759): a terminal title write replaced every workspace's tab
// buckets in the Activity projection and rebuilt its tab context and host indexes over the fleet.

let reads = 0
function counted<T extends object>(row: T): T {
  for (const [key, value] of Object.entries(row)) {
    Object.defineProperty(row, key, {
      enumerable: true,
      get: () => {
        reads++
        return value
      }
    })
  }
  return row
}

function terminal(worktreeId: string, title: string): TerminalTab {
  return counted(
    makeTerminalTab({ id: `term-${worktreeId}`, worktreeId, ptyId: `pty-${worktreeId}`, title })
  )
}

function unified(worktreeId: string, label: string): Tab[] {
  return [
    counted(
      makeUnifiedTab({
        id: `unified-${worktreeId}`,
        worktreeId,
        groupId: 'g',
        entityId: `term-${worktreeId}`,
        label,
        executionHostId: 'local'
      })
    ),
    counted(
      makeStructuredChatTab({
        id: `chat-${worktreeId}`,
        worktreeId,
        entityId: `session-${worktreeId}`,
        sortOrder: 1
      })
    )
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
