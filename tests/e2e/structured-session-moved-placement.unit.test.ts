import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { beforeEach, expect, it, vi } from 'vitest'
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
import { applyWebSessionTabsSnapshot } from '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import { applyLocalStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import {
  makeState,
  resetWebSessionTabsSyncTestState
} from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'
import type { Tab } from '../../src/shared/tab-types'
import { restoredChatTabChanges } from '../../src/main/runtime/session-tabs/restored-chat-tab-changes'
import { structuredSessionPlacementAllowed } from '../../src/main/runtime/session-tabs/structured-session-placement'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
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

// A window's own frame for a workspace: its non-chat rows, and its chats only as group order.
const windowFrame = (
  worktree: string,
  snapshotVersion: number,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs'] = [],
  chats: string[] = []
): RuntimeMobileSessionTabsSnapshot => ({
  worktree,
  publicationEpoch: 'renderer',
  snapshotVersion,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabGroups: [
    {
      id: 'window-group',
      activeTabId: null,
      tabOrder: [...tabs.map((tab) => tab.id), ...chats.map((id) => `agent-session:${id}`)]
    }
  ],
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
  // Only the window has its content: nothing goes out until it resends, which its next graph asks for.
  expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
  const resync = new Set<string>()
  rig.runtime['syncMobileSessionTabs']([], [rig.old], resync)
  expect([...resync]).toEqual([rig.old])
  rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 8, [notes], [B])])
  const corrected = rig.runtime['toMobileSessionTabsResult'](
    rig.runtime.mobileSessionTabsByWorktree.get(rig.old)!
  )
  expect(corrected.snapshotVersion).toBeGreaterThan(before)
  expect(corrected.tabs.map((tab) => tab.id)).toEqual([notes.id])
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

// The real clients: an attached window applies chats only; a paired desktop applies the whole frame.
const PAIRED = 'paired-host'
const pairedApply = (frames: RuntimeMobileSessionTabsResult[], state = makeState()) =>
  frames.reduce(
    (current, frame) => ({
      ...current,
      ...applyWebSessionTabsSnapshot(current, frame, PAIRED, Date.now())
    }),
    state
  )
const localApply = (
  frames: RuntimeMobileSessionTabsResult[],
  state: ReturnType<typeof makeState>
) =>
  frames.reduce(
    (current, frame) => applyLocalStructuredSessionTabSnapshots(current as never, [frame]),
    state
  ) as ReturnType<typeof makeState>
const shown = (state: ReturnType<typeof makeState>, workspace: string) =>
  (state.unifiedTabsByWorktree[workspace] ?? [])
    .map((tab) => (tab.contentType === 'agent-session' ? tab.entityId : tab.contentType))
    .sort()
const windowTab = (workspace: string, entityId: string, contentType: Tab['contentType']): Tab => ({
  id: contentType === 'agent-session' ? `structured-agent-session-${entityId}` : entityId,
  entityId,
  groupId: 'window-group',
  worktreeId: workspace,
  executionHostId: 'local',
  contentType,
  label: entityId,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})
/** An attached window already showing B, C and notes.md at the old workspace. */
const windowShowing = (workspace: string) =>
  makeState({
    unifiedTabsByWorktree: {
      [workspace]: [
        windowTab(workspace, B, 'agent-session'),
        windowTab(workspace, C, 'agent-session'),
        windowTab(workspace, notes.id, 'editor')
      ]
    }
  })
const withoutLabels = (rig: AuthorityRig) => {
  const saved = rig.profile.getWorkspaceSession('local')!
  rig.profile.setWorkspaceSession({
    ...saved,
    unifiedTabs: {
      ...saved.unifiedTabs,
      [rig.old]: saved.unifiedTabs![rig.old].map(({ agentSessionAgent: _label, ...tab }) => tab)
    }
  })
}
const resultAt = (rig: AuthorityRig, workspace: string) =>
  rig.runtime['toMobileSessionTabsResult'](rig.runtime.mobileSessionTabsByWorktree.get(workspace)!)

beforeEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

it('K9: an attached window with no old frame is asked to resend, and its resend comes back whole to both clients', async () => {
  const rig = await retired([C])
  attachWindow(rig)
  withoutLabels(rig)
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
  const published: RuntimeMobileSessionTabsResult[] = []
  const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  // Unavailable: nothing incomplete goes out for the old workspace.
  expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
  // The wake: the window's next graph lists the workspace unchanged and is asked for all of it.
  const resync = new Set<string>()
  rig.runtime['syncMobileSessionTabs']([], [rig.old, rig.destination], resync)
  expect(resync.has(rig.old)).toBe(true)
  // Its resend: notes.md as a row, B and C only as order, as a window publishes them.
  // The window answers every requested resend; the destination's lists B, as its layout does.
  const changed = rig.runtime['syncMobileSessionTabs']([
    windowFrame(rig.old, 8, [notes], [B, C]),
    ...(resync.has(rig.destination) ? [windowFrame(rig.destination, 1, [], [B])] : [])
  ])
  expect(changed.has(rig.old)).toBe(true)
  const settled = resultAt(rig, rig.old)
  expect(settled.tabs.map((tab) => tab.id)).toEqual([notes.id, `agent-session:${C}`])
  expect(chatsIn(settled.tabs, C)).toMatchObject([
    { agent: rig.store.getConversation(C)!.provider }
  ])
  const destination = resultAt(rig, rig.destination)
  expect(chatsIn(destination.tabs)).toHaveLength(1)
  // Both real clients: B leaves the old workspace only, C and notes.md stay.
  const local = localApply([settled, destination], windowShowing(rig.old))
  expect(shown(local, rig.old)).toEqual([C, 'editor'])
  expect(shown(local, rig.destination)).toEqual([B])
  const paired = pairedApply([settled, destination])
  expect(shown(paired, rig.old)).toEqual([C, 'editor'])
  expect(shown(paired, rig.destination)).toEqual([B])
  // An already-current retry and the window's unchanged graph: no resend, no restamp, nothing new.
  const acquired = rig.acquire.mock.calls.length
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  const again = new Set<string>()
  rig.runtime['syncMobileSessionTabs']([], [rig.old, rig.destination], again)
  stop()
  expect([...again]).toEqual([])
  expect(resultAt(rig, rig.old)).toEqual(settled)
  expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
  expect(rig.acquire.mock.calls.length - acquired).toBe(0)
})

it('K10: a windowless host projects the old workspace it publishes whole from its saved layout, once, for both clients', async () => {
  const rig = await retired([C])
  withoutLabels(rig)
  const file = {
    filePath: notes.filePath,
    relativePath: notes.relativePath,
    worktreeId: rig.old,
    language: 'plaintext'
  }
  const saved = rig.profile.getWorkspaceSession('local')!
  rig.profile.setWorkspaceSession({
    ...saved,
    openFilesByWorktree: { ...saved.openFilesByWorktree, [rig.old]: [file] }
  })
  // The host already publishes a chat-only frame there: B's own projection.
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
  project(rig, rig.old)
  const held = resultAt(rig, rig.old)
  expect(held.tabs.map((tab) => tab.type)).toEqual(['agent-session'])
  const published: RuntimeMobileSessionTabsResult[] = []
  const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  const oldFrames = published.filter((snapshot) => snapshot.worktree === rig.old)
  expect(oldFrames).toHaveLength(1)
  const [projected] = oldFrames
  expect(
    projected.tabs.map((tab) => (tab.type === 'agent-session' ? tab.sessionId : tab.type))
  ).toEqual(['file', C])
  // A paired desktop that mirrored notes.md, B and C keeps notes.md and C.
  const mirrored = pairedApply([
    {
      ...projected,
      publicationEpoch: 'earlier',
      snapshotVersion: 1,
      tabs: [...projected.tabs, ...held.tabs]
    }
  ])
  expect(shown(mirrored, rig.old)).toEqual([B, C, 'editor'])
  expect(shown(pairedApply([projected], mirrored), rig.old)).toEqual([C, 'editor'])
  expect(shown(localApply([projected], windowShowing(rig.old)), rig.old)).toEqual([C, 'editor'])
  // An already-current retry and an inventory read publish nothing more and keep the projection.
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  expect(await listedAt(rig, rig.old)).toEqual([])
  expect(await listedAt(rig, rig.old, C)).toHaveLength(1)
  stop()
  expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toHaveLength(1)
})

it('one move over S old workspaces and the resends that follow cost a bounded amount per workspace at S and 10S, with no catalog reads', async () => {
  const rig = await retired()
  await reveal(rig)
  const store = rig.runtime.storeMobileSessionSnapshot.bind(rig.runtime)
  const counts = { catalog: 0, sessions: 0, records: 0, rows: 0, emitted: 0 }
  vi.spyOn(rig.profile, 'getRepos').mockImplementation(() => {
    counts.catalog++
    return []
  })
  const sessions = rig.profile.getWorkspaceSession.bind(rig.profile)
  vi.spyOn(rig.profile, 'getWorkspaceSession').mockImplementation((...args) => {
    counts.sessions++
    return sessions(...args)
  })
  const conversation = rig.store.getConversation.bind(rig.store)
  vi.spyOn(rig.store, 'getConversation').mockImplementation((id) => {
    counts.records++
    return conversation(id)
  })
  vi.spyOn(rig.runtime, 'storeMobileSessionSnapshot').mockImplementation((workspace, snapshot) => {
    counts.rows += snapshot.tabs.length
    return store(workspace, snapshot)
  })
  rig.runtime.onMobileSessionTabsChanged(() => counts.emitted++)
  const tally: Record<string, number[]> = {}
  const record = (phase: string) => {
    for (const [key, value] of Object.entries(counts)) {
      ;(tally[`${phase}.${key}`] ??= []).push(value)
    }
    Object.assign(counts, { catalog: 0, sessions: 0, records: 0, rows: 0, emitted: 0 })
  }
  for (const width of [20, 200]) {
    const keys = Array.from({ length: width }, (_, i) => `gone-${width}-${i}::${root}/gone-${i}`)
    let session = getDefaultWorkspaceSession()
    for (const key of keys) {
      session = withChatTabChanges('local', session, key, [
        { open: { sessionId: B, agent: 'codex' as const, tabId: `agent-session:${B}` } }
      ])!
    }
    rig.profile.setWorkspaceSession(session)
    // Windowless: each old workspace the host already publishes, chat-only.
    for (const key of keys) {
      rig.runtime.mobileSessionTabsByWorktree.delete(key)
      project(rig, key)
    }
    Object.assign(counts, { catalog: 0, sessions: 0, records: 0, rows: 0, emitted: 0 })
    await rig.runtime.retireMovedStructuredSessionPlacement(B)
    record('windowless')
    // Attached: the same workspaces are the window's; it is asked to resend, then resends.
    const window = attachWindow(rig)
    rig.runtime['syncMobileSessionTabs'](keys.map((key) => windowFrame(key, 1, [notes], [B])))
    for (const key of keys) {
      project(rig, key)
    }
    Object.assign(counts, { catalog: 0, sessions: 0, records: 0, rows: 0, emitted: 0 })
    await rig.runtime.retireMovedStructuredSessionPlacement(B)
    const resync = new Set<string>()
    rig.runtime['syncMobileSessionTabs']([], keys, resync)
    expect(resync.size).toBe(width)
    const changed = rig.runtime['syncMobileSessionTabs'](
      keys.map((key) => windowFrame(key, 2, [notes], [B]))
    )
    expect(changed.size).toBe(width)
    record('attached')
    window.mockRestore()
  }
  console.log('EXPERIMENT_B_COUNTS', JSON.stringify(tally))
  // Catalog reads do not grow with the workspaces: none at all windowless, one per graph sync.
  expect(tally['windowless.catalog']).toEqual([0, 0])
  expect(tally['attached.catalog']).toEqual([2, 2])
  expect(tally['windowless.emitted']).toEqual([20, 200])
  expect(tally['attached.emitted']).toEqual([0, 0])
  for (const [key, [small, large]] of Object.entries(tally)) {
    expect([key, large]).toEqual([key, expect.any(Number)])
    expect(large, key).toBeLessThanOrEqual(Math.max(12 * small, 1))
  }
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
