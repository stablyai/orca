import { expect, it } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { advanceActivityTabs } from './activity-tab-projection'
import { resolveActivityTabIndexes } from './activity-event-build-cache'

function tab(worktreeId: string, id: string, fields: Partial<Tab>): Tab {
  return {
    id,
    entityId: id,
    groupId: 'g',
    worktreeId,
    contentType: 'terminal',
    label: 'shell',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...fields
  }
}

const chat = (worktreeId: string) =>
  tab(worktreeId, 'dup', { contentType: 'agent-session', agentSessionAgent: 'codex', label: 'Chat' })

it('a title write after a workspace reorder keeps the full rebuild owner of a shared chat id', () => {
  const terminal = tab('B', 'term-b', { entityId: 'term-b' })
  const first = { A: [chat('A')], B: [chat('B'), terminal] }
  const projected = advanceActivityTabs(first, null, null)
  const [chatA] = first.A
  const withoutA = replaceTabBuckets(first, [['A', null]])
  const reordered = replaceTabBuckets(withoutA, [['A', [chatA]]])
  const afterReorder = advanceActivityTabs(reordered, first, projected)
  const retitled = replaceTabBuckets(reordered, [
    ['B', [reordered.B[0], { ...terminal, label: 'vim' }]]
  ])
  const afterTitle = advanceActivityTabs(retitled, reordered, afterReorder)

  const { context } = resolveActivityTabIndexes(
    { tabsByWorktree: {}, unifiedTabsByWorktree: afterTitle, chatNames: new Map() },
    undefined
  )
  // The source now lists B first, and the first workspace holding a chat id owns it.
  expect(context.get('dup')?.worktreeId).toBe('B')
})
