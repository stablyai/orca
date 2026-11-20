import { expect, it, vi } from 'vitest'
import { replaceTabBuckets } from '@/store/record-transitions/keyed-record-transitions'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
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
    {
      ...base,
      id: `c-${worktreeId}`,
      entityId: `session-${worktreeId}`,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Chat',
      sortOrder: 1
    }
  ]
}

function workForTitleWrite(workspaces: number): { hashes: number; sleepLookups: number } {
  let sleepLookups = 0
  // Each scanned chat looks itself up here, so this counts chats a pass visits.
  const sleptAt = new Proxy(
    {},
    {
      get(target, key, receiver) {
        sleepLookups++
        return Reflect.get(target, key, receiver)
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
  return { hashes: hashes.count, sleepLookups }
}

it('a terminal title write rescans and hashes no chat, at N and 10N chats', () => {
  for (const chats of [2_500, 25_000]) {
    expect(workForTitleWrite(chats)).toEqual({ hashes: 0, sleepLookups: 0 })
  }
})
