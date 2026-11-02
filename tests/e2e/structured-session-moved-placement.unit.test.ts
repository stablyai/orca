import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  authorityProfile,
  openAuthorityRuntime,
  reveal,
  inWorkspace,
  physicalReload,
  type AuthorityRig
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import { editPersistedTestAgentSessionStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { withChatTabChanges } from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { getRepoMainWorktreeId } from '../../src/shared/worktree/id'
import {
  withPlacedSavedChatTabPatch,
  withPlacedSavedChatTabs
} from '../../src/main/runtime/session-tabs/saved-chat-tab-placement'
import { restoredChatTabChanges } from '../../src/main/runtime/session-tabs/restored-chat-tab-changes'
import { structuredSessionPlacementAllowed } from '../../src/main/runtime/session-tabs/structured-session-placement'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
// The shipped layout owner: a window saves its own layout whole.
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

async function retired() {
  const old = `retired-project::${root}`
  const input = await inWorkspace(old, 'folder')
  input.profile.removeFolderWorkspace(input.folderId)
  input.profile.setWorkspaceSession(
    withChatTabChanges('local', getDefaultWorkspaceSession(), old, [
      { open: { sessionId: B, agent: 'codex', tabId: `agent-session:${B}` } }
    ])!
  )
  const rig = await openAuthorityRuntime(input)
  const repo = storeRepo({ id: 'current-project', path: root, kind: 'folder' })
  rig.profile.addRepo(repo)
  return { ...rig, old, destination: getRepoMainWorktreeId(repo) }
}

// Only the host's window availability seam; no app or window is launched.
const attachWindow = (rig: AuthorityRig) =>
  vi.spyOn(rig.runtime, 'getAvailableAuthoritativeWindow' as never).mockReturnValue({
    id: 1,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  } as never)

const project = (rig: AuthorityRig, workspaceId: string) =>
  rig.runtime.projectStructuredAgentSessionTab({
    workspaceId,
    sessionId: B,
    agent: rig.store.getConversation(B)!.provider,
    activate: false
  })
const chatsIn = (tabs: RuntimeMobileSessionTabsResult['tabs'] | undefined) =>
  (tabs ?? []).filter((tab) => tab.type === 'agent-session' && tab.sessionId === B)
const listedAt = async (rig: AuthorityRig, workspace: string) =>
  chatsIn(
    (await rig.runtime.listAllMobileSessionTabs()).find((row) => row.worktree === workspace)?.tabs
  )
const savedAt = (rig: AuthorityRig, workspace: string, derived = true) => {
  const saved = rig.profile.getWorkspaceSession('local')!
  return (
    (derived ? withPlacedSavedChatTabs(saved, 'local') : saved).unifiedTabs?.[workspace] ?? []
  ).filter((tab) => tab.entityId === B)
}

it('a phone move with an attached window republishes the old frame without the chat, even when the destination tab already exists and the old registration returns', async () => {
  const rig = await retired()
  const window = attachWindow(rig)
  project(rig, rig.old)
  project(rig, rig.destination)
  const before = rig.runtime.mobileSessionTabsByWorktree.get(rig.old)!.snapshotVersion
  const published: RuntimeMobileSessionTabsResult[] = []
  const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: rig.destination }
    })
  }
  stop()
  // The window replaces its old slice from a newer frame that no longer lists the chat.
  const oldFrames = published.filter((snapshot) => snapshot.worktree === rig.old)
  expect(oldFrames.at(-1)?.snapshotVersion).toBeGreaterThan(before)
  expect(chatsIn(oldFrames.at(-1)?.tabs)).toEqual([])
  expect(await listedAt(rig, rig.old)).toEqual([])
  expect(await listedAt(rig, rig.destination)).toHaveLength(1)
  // The window owns the saved layout, so the old row stays as a hint no read shows.
  expect(savedAt(rig, rig.old, false)).toHaveLength(1)
  expect(savedAt(rig, rig.old)).toEqual([])
  // A partial window save of the stale tabs stores them placed too.
  const stored = rig.profile.getWorkspaceSession('local')!
  const patch = withPlacedSavedChatTabPatch(stored, { unifiedTabs: stored.unifiedTabs }, 'local')
  expect((patch.unifiedTabs?.[rig.old] ?? []).filter((tab) => tab.entityId === B)).toEqual([])
  rig.profile.addRepo(storeRepo({ id: 'retired-project', path: root, kind: 'folder' }))
  expect(await listedAt(rig, rig.old)).toEqual([])
  expect(savedAt(rig, rig.old)).toEqual([])
  window.mockRestore()
  const fresh = await physicalReload(rig)
  expect(fresh.store.getRecord(B)?.location.workspaceId).toBe(rig.destination)
  expect(savedAt(fresh, rig.old, false)).toEqual([])
  expect(await listedAt(fresh, rig.old)).toEqual([])
})

it('a delayed old-workspace frame and the empty frame after it cannot bring the moved chat back', async () => {
  const rig = await retired()
  project(rig, rig.old)
  const old = rig.runtime.mobileSessionTabsByWorktree.get(rig.old)!
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  const delayed = {
    ...old,
    publicationEpoch: 'same-live-renderer',
    snapshotVersion: old.snapshotVersion + 10
  }
  rig.runtime['syncMobileSessionTabs']([delayed])
  expect(await listedAt(rig, rig.old)).toEqual([])
  rig.runtime['syncMobileSessionTabs']([
    {
      ...delayed,
      snapshotVersion: delayed.snapshotVersion + 1,
      tabs: [],
      activeTabId: null,
      activeTabType: null,
      tabGroups: []
    }
  ])
  expect(await listedAt(rig, rig.old)).toEqual([])
})

it('drops an equivalent spelling of the old workspace from inventory, across repeated reveals and an unchanged frame', async () => {
  const original = `retired::${root}`
  const alias = `${original}/`
  const input = await inWorkspace(original, 'folder')
  input.profile.removeFolderWorkspace(input.folderId)
  const rig = await openAuthorityRuntime(input)
  project(rig, alias)
  rig.runtime['syncMobileSessionTabs']([rig.runtime.mobileSessionTabsByWorktree.get(alias)!])
  expect(await listedAt(rig, alias)).toHaveLength(1)
  rig.profile.addRepo(storeRepo({ id: 'current', path: root, kind: 'folder' }))
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: `current::${root}` }
  })
  expect(await listedAt(rig, alias)).toEqual([])
  expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
  rig.runtime['syncMobileSessionTabs']([], [alias])
  expect(await listedAt(rig, alias)).toEqual([])
})

it('keeps the placement of a chat whose record is unreadable but observable', async () => {
  const input = await authorityProfile([B])
  await editPersistedTestAgentSessionStore(root, (persisted) => {
    Object.assign(persisted.records[B].lease, { minimumNextFence: 'bad' })
  })
  const rig = await openAuthorityRuntime(input)
  expect(rig.store.isSessionUnreadable(B)).toBe(true)
  expect(rig.store.getConversation(B)?.location.workspaceId).toBe(input.workspace)
  const old = 'retired::/project'
  expect(structuredSessionPlacementAllowed(old, B)).toBe(true)
  project(rig, old)
  expect(await listedAt(rig, old)).toHaveLength(1)
  const tabs = rig.profile.getWorkspaceSession('local')?.unifiedTabs?.[input.workspace] ?? []
  const changes = restoredChatTabChanges(
    { [old]: tabs.map((tab) => ({ ...tab, worktreeId: old })) },
    rig.host,
    [],
    () => false,
    (id, workspace) => structuredSessionPlacementAllowed(workspace, id)
  )
  expect(changes.get(old)?.filter((change) => 'close' in change) ?? []).toEqual([])
})

it('derives one stale frame of N moved chats in one pass at N and 10N', async () => {
  const rig = await retired()
  const record = rig.store.getRecord(B)!
  // Every chat in the frame belongs to the destination now.
  vi.spyOn(rig.store, 'getRecord').mockImplementation(() => ({
    ...record,
    location: { ...record.location, workspaceId: rig.destination }
  }))
  const counts: number[] = []
  for (const n of [20, 200]) {
    let count = 0
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: rig.old,
      publicationEpoch: 'delayed-renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: Array.from({ length: n }, (_, i) => ({
        type: 'agent-session' as const,
        get id() {
          count++
          return `agent-session:chat-${i}`
        },
        sessionId: `chat-${i}`,
        title: 'Chat',
        agent: 'codex' as const,
        isActive: false
      }))
    }
    expect(rig.runtime['toMobileSessionTabsResult'](snapshot).tabs).toEqual([])
    counts.push(count)
  }
  expect(counts[1]).toBeLessThanOrEqual(12 * counts[0])
})

it('an already-current reveal reads no unrelated saved workspace at any population', async () => {
  const rig = await retired()
  await reveal(rig)
  // An attached window owns the saved layout, so only reveal's own reads are counted.
  attachWindow(rig)
  const visits: number[] = []
  for (const width of [20, 200]) {
    let count = 0
    const tabs = Object.fromEntries(
      Array.from({ length: width }, (_, i) => [
        `removed-${i}::/unrelated/${i}`,
        Array.from({ length: 10 }, (_, j) => ({
          contentType: 'agent-session',
          get entityId() {
            count++
            return `unrelated-${i}-${j}`
          }
        }))
      ])
    )
    const saved = rig.profile.getWorkspaceSession('local')!
    const spy = vi
      .spyOn(rig.profile, 'getWorkspaceSession')
      .mockReturnValue({ ...saved, unifiedTabs: { ...saved.unifiedTabs, ...tabs } } as never)
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    expect(await reveal(rig)).toMatchObject({ ok: true, result: { ok: true } })
    spy.mockRestore()
    visits.push(count)
  }
  expect(visits).toEqual([0, 0])
})
