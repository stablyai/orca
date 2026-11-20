import { expect, it, vi } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'

// Perf contract (tracked in #PR_NUMBER): every terminal title write rescanned every structured chat
// for the sidebar's chat workspaces and re-hashed each session id once the pane-key memo overflowed.

const hashes = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../../../shared/hashing/sha256', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../shared/hashing/sha256')>()
  return {
    ...actual,
    sha256: (message: Uint8Array) => {
      hashes.count++
      return actual.sha256(message)
    }
  }
})

function workspaceTabs(worktreeId: string): Tab[] {
  const base = { groupId: 'g', worktreeId, customLabel: null, color: null, createdAt: 1 }
  return [
    { ...base, id: `t-${worktreeId}`, entityId: `term-${worktreeId}`, contentType: 'terminal', label: 'shell', sortOrder: 0 },
    { ...base, id: `c-${worktreeId}`, entityId: `session-${worktreeId}`, contentType: 'agent-session', label: 'Chat', sortOrder: 1 }
  ]
}

function hashesForTitleWrite(workspaces: number): number {
  const tabs: Record<string, Tab[]> = {}
  for (let index = 0; index < workspaces; index++) {
    tabs[`wt-${workspaces}-${index}`] = workspaceTabs(`wt-${workspaces}-${index}`)
  }
  getWorktreeIdsWithStructuredChat(tabs)
  const [terminal, chat] = tabs[`wt-${workspaces}-0`]
  const retitled = replaceTabBuckets(tabs, [[`wt-${workspaces}-0`, [{ ...terminal, label: 'vim' }, chat]]])
  hashes.count = 0
  getWorktreeIdsWithStructuredChat(retitled)
  return hashes.count
}

it('a terminal title write hashes no chat session id, at N and 10N chats', () => {
  expect(hashesForTitleWrite(2_500)).toBe(0)
  expect(hashesForTitleWrite(25_000)).toBe(0)
})
