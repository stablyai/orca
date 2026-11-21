import { expect, it } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import { makeStructuredChatTab, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { advanceActivityTabs } from './activity-tab-projection'
import { resolveActivityTabIndexes } from './activity-event-build-cache'

const chat = (worktreeId: string) =>
  makeStructuredChatTab({ id: 'dup', worktreeId, entityId: 'session-dup' })

it('a title write after a workspace reorder keeps the full rebuild owner of a shared chat id', () => {
  const terminal = makeUnifiedTab({ id: 'term-b', worktreeId: 'B', groupId: 'g' })
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
