// Guards STA-18283 (follow-up to #48722): a bot list's folded-history attention re-reads only the
// workspaces a store write changed, so an agent status update outside the list reads none of them.
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type * as StatusModule from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { createWatchedAttentionReader } from './bot-sidebar-attention'

let reads = 0

vi.mock(
  '@/components/sidebar/workspace-card/activity/use-worktree-activity-status',
  async (importOriginal) => {
    const actual = await importOriginal<typeof StatusModule>()
    return {
      ...actual,
      // Each workspace whose card status is read counts once.
      selectWorktreeActivityStatus: (
        ...args: Parameters<typeof actual.selectWorktreeActivityStatus>
      ) => {
        reads += 1
        return actual.selectWorktreeActivityStatus(...args)
      }
    }
  }
)

const WATCHED = Array.from({ length: 300 }, (_, index) => `wt-${index}`)

function report(worktreeId: string, state: 'working' | 'done', prompt: string): void {
  const tabId = `tab-${worktreeId}`
  useAppStore
    .getState()
    .setAgentStatus(`${tabId}:1`, { state, prompt, agentType: 'claude' }, 'Claude', undefined, {
      tabId,
      worktreeId
    })
}

beforeEach(() => {
  const ids = [...WATCHED, 'wt-elsewhere']
  useAppStore.setState({
    tabsByWorktree: Object.fromEntries(
      ids.map((id) => [id, [makeTab({ id: `tab-${id}`, worktreeId: id })]])
    )
  })
  report('wt-elsewhere', 'working', 'first')
  report('wt-7', 'done', 'first')
})

it('reads no watched workspace for a status update elsewhere or a redraw, and only the one that changed', () => {
  const read = createWatchedAttentionReader()
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])

  reads = 0
  report('wt-elsewhere', 'working', 'second')
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])
  expect(reads).toBe(0)

  report('wt-7', 'working', 'second')
  expect(read(useAppStore.getState(), WATCHED)).toEqual(['wt-7'])
  expect(reads).toBe(1)

  reads = 0
  report('wt-7', 'done', 'third')
  expect(read(useAppStore.getState(), WATCHED)).toEqual([])
  expect(reads).toBe(1)

  // A list redrawn with the same workspaces reads none of them again.
  reads = 0
  expect(read(useAppStore.getState(), [...WATCHED])).toEqual([])
  expect(reads).toBe(0)
})
