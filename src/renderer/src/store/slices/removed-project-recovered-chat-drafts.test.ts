// Exercise production project removal and draft persistence; only the host location read is external.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from './worktrees/worktree.test-fixture'
import { makeUnifiedTab } from './tabs/tab-group.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  setNativeChatComposerDraftOwnerResolver,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { resolveNativeChatDraftOwner } from '@/components/native-chat/drafts/native-chat-draft-owner'
import { createChatDraftRemovalReceipt } from './worktrees/teardown/chat-draft-removal-receipt'
import type { ExecutionHostId } from '../../../../shared/execution-host'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

const OLD = 'old-registration::/work/project'
const NEW = 'new-registration::/work/project'
const SESSION = 'recovered-chat-37190'
const B = `agent-session:${SESSION}`
const OTHER = 'agent-session:neighbour-37190'
const FOREIGN = 'agent-session:other-host-37190'
const removeForHost = vi.fn().mockResolvedValue(undefined)
const { locate } = vi.hoisted(() => ({ locate: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  callRuntimeRpc: locate
}))

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.clearAllMocks()
  removeForHost.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      repos: { removeForHost },
      pty: { kill: vi.fn() },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})
afterEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.unstubAllGlobals()
})

async function fixture(current: string, tabOpen = true, hostId: ExecutionHostId = 'local') {
  const store = createTestStore()
  const repo = (id: string) => ({
    id,
    path: '/work/project',
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: hostId
  })
  const tab = makeUnifiedTab({
    id: 'B-tab',
    entityId: SESSION,
    contentType: 'agent-session',
    executionHostId: hostId,
    worktreeId: current,
    groupId: 'B-group'
  })
  // Post-recovery renderer state from S7, plus the returned same-host old registration.
  locate.mockImplementation(async (_target, method, params) => {
    if (method !== 'orchestration.partyLocation') {
      throw new Error('Unexpected cleanup operation')
    }
    const sessionId = params.address.slice('orca_session_id:'.length)
    return {
      location: { kind: 'chat', sessionId, worktreeId: sessionId === SESSION ? current : NEW }
    }
  })
  store.setState({
    repos: [repo('old-registration'), repo('new-registration')],
    worktreesByRepo: {
      'old-registration': [
        makeWorktree({
          id: OLD,
          repoId: 'old-registration',
          path: '/work/project',
          hostId
        })
      ],
      'new-registration': [
        makeWorktree({
          id: NEW,
          repoId: 'new-registration',
          path: '/work/project',
          hostId
        })
      ]
    },
    tabsByWorktree: {},
    unifiedTabsByWorktree: tabOpen ? { [current]: [tab] } : {}
  })
  const storage = createMemoryNativeChatComposerDraftStorage()
  storage.drafts.set(B, {
    text: 'B unsent before recovery',
    images: [],
    savedAt: 1,
    owner: { workspaceId: OLD, executionHostId: hostId }
  })
  storage.drafts.set(OTHER, {
    text: 'neighbour unsent',
    images: [],
    savedAt: 2,
    owner: { workspaceId: NEW, executionHostId: hostId }
  })
  storage.drafts.set(FOREIGN, {
    text: 'foreign unsent',
    images: [],
    savedAt: 3,
    owner: { workspaceId: OLD, executionHostId: 'runtime:other' }
  })
  setNativeChatComposerDraftStorageForTests(storage)
  setNativeChatComposerDraftOwnerResolver((scope) =>
    resolveNativeChatDraftOwner(store.getState(), scope)
  )
  await hydrateNativeChatComposerDrafts()
  return { store, storage }
}

it('returned old project removal must preserve B now in the new registration (original failure)', async () => {
  const { store, storage } = await fixture(NEW)
  expect(resolveNativeChatDraftOwner(store.getState(), B)).toEqual({
    workspaceId: NEW,
    executionHostId: 'local'
  })
  // Even an explicit current owner on a real changed write cannot refresh the saved one.
  updateNativeChatComposerDraft(
    B,
    { text: 'B edited after recovery', owner: { workspaceId: NEW, executionHostId: 'local' } },
    'immediate'
  )
  await nativeChatComposerDraftWritesSettled()
  expect(storage.drafts.get(B)?.owner).toEqual({ workspaceId: OLD, executionHostId: 'local' })
  await store.getState().removeProject('old-registration', { hostId: 'local' })
  await nativeChatComposerDraftWritesSettled()
  expect(removeForHost).toHaveBeenCalledWith({ repoId: 'old-registration', hostId: 'local' })
  expect(store.getState().repos.map((r) => r.id)).toEqual(['new-registration'])
  expect(store.getState().unifiedTabsByWorktree[NEW]?.map((t) => t.entityId)).toEqual([SESSION])
  expect(storage.drafts.get(OTHER)?.text).toBe('neighbour unsent')
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
  expect(locate).toHaveBeenCalledWith(
    { kind: 'local' },
    'orchestration.partyLocation',
    { address: 'orca_session_id:recovered-chat-37190' },
    expect.any(Object)
  )
  expect(readNativeChatComposerDraft(B).text).toBe('B edited after recovery')
  expect(storage.drafts.get(B)?.text).toBe('B edited after recovery')
})

it('main-coherent old-location control: removing B own old project deletes B intentionally', async () => {
  const { store, storage } = await fixture(OLD)
  await store.getState().removeProject('old-registration', { hostId: 'local' })
  await nativeChatComposerDraftWritesSettled()
  expect(storage.drafts.has(B)).toBe(false)
  expect(storage.drafts.get(OTHER)?.text).toBe('neighbour unsent')
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
})

it('removing the current project clears a closed recovered conversation despite its saved old owner', async () => {
  const { store, storage } = await fixture(NEW, false)
  await store.getState().removeProject('new-registration', { hostId: 'local' })
  await nativeChatComposerDraftWritesSettled()
  expect(store.getState().repos.map((r) => r.id)).toEqual(['old-registration'])
  expect(storage.drafts.has(B)).toBe(false)
  expect(readNativeChatComposerDraft(B).text).toBe('')
  expect(locate).toHaveBeenCalledWith(
    { kind: 'local' },
    'orchestration.partyLocation',
    { address: 'orca_session_id:recovered-chat-37190' },
    expect.any(Object)
  )
  expect(storage.drafts.has(OTHER)).toBe(false)
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
})

it('unavailable membership retains the draft while local removal succeeds', async () => {
  const { store, storage } = await fixture(OLD)
  locate.mockRejectedValue(new Error('Host unavailable'))
  await store.getState().removeProject('old-registration', { hostId: 'local' })
  await nativeChatComposerDraftWritesSettled()
  expect(store.getState().repos.map((repo) => repo.id)).toEqual(['new-registration'])
  expect(readNativeChatComposerDraft(B).text).toBe('B unsent before recovery')
  expect(storage.drafts.get(B)?.text).toBe('B unsent before recovery')
})

it('a lineage successor is not positive membership for the original conversation', async () => {
  const { store, storage } = await fixture(OLD)
  locate.mockResolvedValue({
    location: { kind: 'chat', sessionId: 'successor-chat-37190', worktreeId: OLD }
  })
  await store.getState().removeProject('old-registration', { hostId: 'local' })
  await nativeChatComposerDraftWritesSettled()
  expect(storage.drafts.get(B)?.text).toBe('B unsent before recovery')
})

it('direct SSH cleanup uses its readable local record store even with no SSH connection', async () => {
  const { store, storage } = await fixture(OLD, false, 'ssh:offline-target')
  await store.getState().removeProject('old-registration', { hostId: 'ssh:offline-target' })
  await nativeChatComposerDraftWritesSettled()
  expect(store.getState().repos.map((repo) => repo.id)).toEqual(['new-registration'])
  expect(storage.drafts.has(B)).toBe(false)
  expect(storage.drafts.get(OTHER)?.text).toBe('neighbour unsent')
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
  expect(locate).toHaveBeenCalledWith(
    { kind: 'local' },
    'orchestration.partyLocation',
    { address: 'orca_session_id:recovered-chat-37190' },
    expect.any(Object)
  )
})

it('one bulk removal settles only successful project selectors', async () => {
  const { store, storage } = await fixture(OLD, false)
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
  removeForHost.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Not removed'))
  const receipt = createChatDraftRemovalReceipt(store.getState)
  for (const projectId of ['old-registration', 'new-registration']) {
    await store.getState().removeProject(projectId, {
      hostId: 'local',
      chatDraftRemovalReceipt: receipt
    })
  }
  await receipt.finish()
  await nativeChatComposerDraftWritesSettled()
  expect(store.getState().repos.map((repo) => repo.id)).toEqual(['new-registration'])
  expect(storage.drafts.has(B)).toBe(false)
  expect(storage.drafts.get(OTHER)?.text).toBe('neighbour unsent')
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
  warn.mockRestore()
})

it('closing a view during the location read does not veto current record membership', async () => {
  const { store, storage } = await fixture(OLD)
  locate.mockImplementation(async (_target, _method, params) => {
    store.setState({ unifiedTabsByWorktree: {} })
    const sessionId = params.address.slice('orca_session_id:'.length)
    return { location: { kind: 'chat', sessionId, worktreeId: sessionId === SESSION ? OLD : NEW } }
  })
  const receipt = createChatDraftRemovalReceipt(store.getState)
  receipt.capture({ executionHostId: 'local' })({ projectId: 'old-registration' })
  await receipt.finish()
  expect(readNativeChatComposerDraft(B).text).toBe('')
  expect(storage.drafts.has(B)).toBe(false)
  expect(storage.drafts.get(OTHER)?.text).toBe('neighbour unsent')
  expect(storage.drafts.get(FOREIGN)?.text).toBe('foreign unsent')
})
