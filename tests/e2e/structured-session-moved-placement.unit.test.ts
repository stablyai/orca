import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  C,
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
import {
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
  type RuntimeMobileSessionFileTab,
  type RuntimeMobileSessionTabsResult,
  type RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
// The shipped layout owner: a window saves its own layout whole.
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

/** B, and any `kept` chats, live in a workspace whose registration is gone. */
async function retired(kept: string[] = []) {
  const old = `retired-project::${root}`
  const input = await inWorkspace(old, 'folder', 'local', kept)
  input.profile.removeFolderWorkspace(input.folderId)
  input.profile.setWorkspaceSession(
    withChatTabChanges(
      'local',
      getDefaultWorkspaceSession(),
      old,
      [B, ...kept].map((sessionId) => ({
        open: { sessionId, agent: 'codex' as const, tabId: `agent-session:${sessionId}` }
      }))
    )!
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
const chatsIn = (tabs: RuntimeMobileSessionTabsResult['tabs'] | undefined, id = B) =>
  (tabs ?? []).filter((tab) => tab.type === 'agent-session' && tab.sessionId === id)
const listedAt = async (rig: AuthorityRig, workspace: string, id = B) =>
  chatsIn(
    (await rig.runtime.listAllMobileSessionTabs()).find((row) => row.worktree === workspace)?.tabs,
    id
  )
const savedAt = (rig: AuthorityRig, workspace: string, derived = true) => {
  const saved = rig.profile.getWorkspaceSession('local')!
  return (
    (derived ? withPlacedSavedChatTabs(saved, 'local') : saved).unifiedTabs?.[workspace] ?? []
  ).filter((tab) => tab.entityId === B)
}

// A window's own frame for a workspace: its non-chat rows, never chats.
const windowFrame = (
  worktree: string,
  snapshotVersion: number,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'] = []
): RuntimeMobileSessionTabsSnapshot => ({
  worktree,
  publicationEpoch: 'renderer',
  snapshotVersion,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabGroups: [{ id: 'window-group', activeTabId: null, tabOrder: tabs.map((tab) => tab.id) }],
  tabs
})
const notes: RuntimeMobileSessionFileTab = {
  type: 'file',
  id: 'notes-tab',
  title: 'notes.md',
  filePath: '/project/notes.md',
  relativePath: 'notes.md',
  language: 'markdown',
  isDirty: false,
  isActive: false
}

it('a phone move with an attached window republishes the old frame without the chat, even when the destination tab already exists and the old registration returns', async () => {
  const rig = await retired()
  const window = attachWindow(rig)
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
  rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 7, [notes])])
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
  // The window replaces its old slice from its own whole frame, newer and without the chat.
  const oldFrames = published.filter((snapshot) => snapshot.worktree === rig.old)
  expect(oldFrames).toHaveLength(1)
  expect(oldFrames[0].snapshotVersion).toBeGreaterThan(before)
  expect(oldFrames[0].tabs.map((tab) => tab.id)).toEqual([notes.id])
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

it("a phone move gives back the window's own old-workspace frame whole: the editor and a neighbour saved without its agent label stay", async () => {
  const rig = await retired([C])
  attachWindow(rig)
  // The optional saved label is gone; the record still says what C is.
  const saved = rig.profile.getWorkspaceSession('local')!
  rig.profile.setWorkspaceSession({
    ...saved,
    unifiedTabs: {
      ...saved.unifiedTabs,
      [rig.old]: saved.unifiedTabs![rig.old].map(({ agentSessionAgent: _label, ...tab }) => tab)
    }
  })
  // The window's frame lists no chats; the host holds none there either.
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
  rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 7, [notes])])
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
  const oldFrames = published.filter((snapshot) => snapshot.worktree === rig.old)
  expect(oldFrames).toHaveLength(1)
  expect(oldFrames[0].snapshotVersion).toBeGreaterThan(before)
  expect(oldFrames[0].publicationEpoch).not.toBe(UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH)
  expect(oldFrames[0].tabs.map((tab) => tab.id)).toEqual([notes.id, `agent-session:${C}`])
  expect(chatsIn(oldFrames[0].tabs, C)).toMatchObject([
    { agent: rig.store.getConversation(C)!.provider }
  ])
  // The window's next unchanged graph leaves the correction in place.
  rig.runtime['syncMobileSessionTabs'](
    [windowFrame(rig.old, 7, [notes])],
    [rig.old, rig.destination]
  )
  expect(await listedAt(rig, rig.old)).toEqual([])
  expect(await listedAt(rig, rig.old, C)).toHaveLength(1)
  expect(await listedAt(rig, rig.destination)).toHaveLength(1)
})

it.each(['has no frame', 'holds a frame this host built'] as const)(
  'a phone move asks a window whose old workspace %s to resend it, without publishing a frame the host cannot complete',
  async (frame) => {
    const rig = await retired()
    attachWindow(rig)
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
    if (frame === 'holds a frame this host built') {
      // Accepted from the window once, then replaced by host rows: counts still match.
      rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 7)])
      project(rig, rig.old)
      const stored = rig.runtime.mobileSessionTabsByWorktree.get(rig.old)!
      rig.runtime.mobileSessionTabsByWorktree.set(rig.old, {
        ...stored,
        publicationEpoch: 'structured:host'
      })
    }
    const published: RuntimeMobileSessionTabsResult[] = []
    const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: rig.destination }
    })
    stop()
    expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
    // The window's next graph lists the workspace unchanged; the answer asks for it in full.
    const resync = new Set<string>()
    rig.runtime['syncMobileSessionTabs']([], [rig.old], resync)
    expect([...resync]).toEqual([rig.old])
    const changed = rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 8, [notes])])
    expect([...changed]).toContain(rig.old)
    expect(await listedAt(rig, rig.old)).toEqual([])
  }
)

it('a real move assembles each old workspace once, at C and 10C chats kept beside the moved one', async () => {
  const rig = await retired()
  attachWindow(rig)
  await reveal(rig)
  const conversation = rig.store.getConversation(B)!
  vi.spyOn(rig.host, 'isSessionTabVisible').mockReturnValue(true)
  vi.spyOn(rig.store, 'getConversation').mockImplementation(
    (id) => ({ ...conversation, sessionId: id }) as never
  )
  const store = rig.runtime.storeMobileSessionSnapshot.bind(rig.runtime)
  let rows = 0
  vi.spyOn(rig.runtime, 'storeMobileSessionSnapshot').mockImplementation((workspace, snapshot) => {
    rows += snapshot.tabs.length
    return store(workspace, snapshot)
  })
  const counts: number[] = []
  for (const kept of [20, 200]) {
    const ids = Array.from({ length: kept }, (_, i) => `kept-${kept}-${i}`)
    rig.profile.setWorkspaceSession(
      withChatTabChanges(
        'local',
        getDefaultWorkspaceSession(),
        rig.old,
        [B, ...ids].map((sessionId) => ({
          open: { sessionId, agent: 'codex' as const, tabId: `agent-session:${sessionId}` }
        }))
      )!
    )
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
    rig.runtime['acceptedRendererMobileSnapshotByWorktree'].delete(rig.old)
    rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, kept, [notes])])
    rows = 0
    await rig.runtime.retireMovedStructuredSessionPlacement(B)
    expect(rig.runtime.mobileSessionTabsByWorktree.get(rig.old)?.tabs).toHaveLength(kept + 1)
    counts.push(rows)
  }
  expect(counts[1]).toBeLessThanOrEqual(12 * counts[0])
})

it("saved reads and saves drop moved chats in one pass that keeps other hosts' tabs and unrelated state, pass after pass", async () => {
  const rig = await retired()
  await reveal(rig)
  const saved = rig.profile.getWorkspaceSession('local')!
  const [moved] = saved.unifiedTabs![rig.old]
  const groupId = saved.tabGroups![rig.old][0].id
  // An unrelated tab beside it, and another host's tab with the same session and tab ID.
  const terminal = { ...moved, id: 'terminal-1', entityId: 'terminal-1', contentType: 'terminal' }
  const foreignWorkspace = 'foreign::/other'
  const foreign = { ...moved, worktreeId: foreignWorkspace, executionHostId: 'runtime:other' }
  const session = {
    ...saved,
    unifiedTabs: {
      ...saved.unifiedTabs,
      [rig.old]: [moved, { ...terminal, groupId }],
      [foreignWorkspace]: [foreign]
    },
    tabGroups: {
      ...saved.tabGroups,
      [rig.old]: [
        {
          id: groupId,
          worktreeId: rig.old,
          activeTabId: moved.id,
          tabOrder: [moved.id, 'terminal-1']
        }
      ],
      [foreignWorkspace]: [
        { id: 'g', worktreeId: foreignWorkspace, activeTabId: foreign.id, tabOrder: [foreign.id] }
      ]
    },
    activeTabIdByWorktree: { [rig.old]: moved.id, [foreignWorkspace]: foreign.id }
  } as typeof saved
  const once = withPlacedSavedChatTabs(session, 'local')
  expect(once.unifiedTabs![rig.old].map((tab) => tab.id)).toEqual(['terminal-1'])
  expect(once.tabGroups![rig.old]).toMatchObject([
    { tabOrder: ['terminal-1'], activeTabId: 'terminal-1' }
  ])
  expect(once.activeTabIdByWorktree?.[rig.old]).toBeUndefined()
  // Untouched: the foreign tab keeps its owner and identity, and unrelated state is the same object.
  expect(once.unifiedTabs![foreignWorkspace]).toBe(session.unifiedTabs![foreignWorkspace])
  expect(once.tabGroups![foreignWorkspace]).toBe(session.tabGroups![foreignWorkspace])
  expect(once.activeTabIdByWorktree?.[foreignWorkspace]).toBe(foreign.id)
  expect(once.tabsByWorktree).toBe(session.tabsByWorktree)
  expect(withPlacedSavedChatTabs(once, 'local')).toBe(once)
  // Two partial saves in a row store the same.
  let stored = session
  for (let pass = 0; pass < 2; pass++) {
    stored = {
      ...stored,
      ...withPlacedSavedChatTabPatch(stored, { unifiedTabs: stored.unifiedTabs }, 'local')
    }
  }
  expect(stored.unifiedTabs).toEqual(once.unifiedTabs)
  expect(stored.unifiedTabs![foreignWorkspace][0].executionHostId).toBe('runtime:other')
})

it('saved reads and saves of N workspaces holding moved chats visit each row a bounded number of times at N and 10N', async () => {
  const rig = await retired()
  await reveal(rig)
  const [moved] = rig.profile.getWorkspaceSession('local')!.unifiedTabs![rig.old]
  const counts: number[] = []
  for (const width of [20, 200]) {
    let count = 0
    const counted = <T extends object>(row: T) =>
      new Proxy(row, {
        get: (target, key, receiver) => {
          count++
          return Reflect.get(target, key, receiver)
        }
      })
    const workspaces = Array.from({ length: width }, (_, i) => `removed-${i}::/old/${i}`)
    const session = {
      ...getDefaultWorkspaceSession(),
      unifiedTabs: Object.fromEntries(
        workspaces.map((workspace) => [
          workspace,
          [
            counted({ ...moved, worktreeId: workspace, groupId: workspace }),
            counted({ ...moved, id: 't', entityId: 't', contentType: 'terminal' as const })
          ]
        ])
      ),
      tabGroups: Object.fromEntries(
        workspaces.map((workspace) => [
          workspace,
          [
            counted({
              id: workspace,
              worktreeId: workspace,
              activeTabId: moved.id,
              tabOrder: [moved.id, 't']
            })
          ]
        ])
      )
    }
    const placed = withPlacedSavedChatTabs(session, 'local')
    expect(
      Object.values(placed.unifiedTabs!)
        .flat()
        .map((tab) => tab.id)
    ).toEqual(workspaces.map(() => 't'))
    withPlacedSavedChatTabPatch(session, { unifiedTabs: session.unifiedTabs }, 'local')
    counts.push(count)
  }
  expect(counts[1]).toBeLessThanOrEqual(12 * counts[0])
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
