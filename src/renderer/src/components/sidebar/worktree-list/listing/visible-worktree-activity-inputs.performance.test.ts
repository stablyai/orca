import { expect, it, vi } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { makeStructuredChatTab, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import type * as Sha256Module from '../../../../../../shared/hashing/sha256'

// Perf contract (tracked in #45759): every terminal title write rescanned every structured chat
// for the sidebar's chat workspaces and re-hashed each session id once the pane-key memo overflowed.

const hashes = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../../../shared/hashing/sha256', async (importOriginal) => {
  const actual = await importOriginal<typeof Sha256Module>()
  return {
    ...actual,
    sha256: (message: Uint8Array) => {
      hashes.count++
      return actual.sha256(message)
    }
  }
})

function workspaceTabs(worktreeId: string): Tab[] {
  return [
    makeUnifiedTab({ id: `t-${worktreeId}`, worktreeId, groupId: 'g' }),
    makeStructuredChatTab({ id: `c-${worktreeId}`, worktreeId, entityId: `session-${worktreeId}` })
  ]
}

function workForTitleWrite(workspaces: number): {
  hashes: number
  sleepLookups: number
  rescanHashes: number
} {
  let sleepLookups = 0
  // Each scanned chat looks itself up here, so this counts chats a pass visits; none is asleep.
  const sleptAt = new Proxy<Record<string, number | null>>(
    {},
    {
      get() {
        sleepLookups++
        return undefined
      }
    }
  )
  const tabs: Record<string, Tab[]> = {}
  for (let index = 0; index < workspaces; index++) {
    tabs[`wt-${workspaces}-${index}`] = workspaceTabs(`wt-${workspaces}-${index}`)
  }
  getWorktreeIdsWithStructuredChat(tabs, sleptAt)
  // The first pass visits every chat, which proves the fixtures are chats.
  expect(sleepLookups).toBe(workspaces)
  const [terminal, chat] = tabs[`wt-${workspaces}-0`]
  const retitled = replaceTabBuckets(tabs, [
    [`wt-${workspaces}-0`, [{ ...terminal, label: 'vim' }, chat]]
  ])
  hashes.count = 0
  sleepLookups = 0
  // No chat is marked asleep, so none rests its workspace.
  expect(getWorktreeIdsWithStructuredChat(retitled, sleptAt).size).toBe(0)
  const work = { hashes: hashes.count, sleepLookups }
  // A new sleep map forces a full pass; chats past the 2,048-entry pane-key memo must not re-hash.
  hashes.count = 0
  getWorktreeIdsWithStructuredChat(retitled, {})
  return { ...work, rescanHashes: hashes.count }
}

it('a terminal title write rescans and hashes no chat, at N and 10N chats', () => {
  for (const chats of [2_500, 25_000]) {
    expect(workForTitleWrite(chats)).toEqual({ hashes: 0, sleepLookups: 0, rescanHashes: 0 })
  }
})
