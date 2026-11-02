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
  holdStartup,
  type AuthorityRig
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../src/main/runtime/rpc/methods/session-tabs'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import { chatTabCommandsSettled } from '../../src/main/runtime/session-layout-apply.test-fixture'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import { editPersistedTestAgentSessionStore } from '../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import {
  withPlacedSavedChatTabPatch,
  withPlacedSavedChatTabs
} from '../../src/main/runtime/session-tabs/saved-chat-tab-placement'
import { applyWebSessionTabsSnapshot } from '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import { applyLocalStructuredSessionTabSnapshots } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../src/renderer/src/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import {
  NOW,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'
import type { Tab } from '../../src/shared/tab-types'
import { useAppStore } from '../../src/renderer/src/store'
import { retireMovedSessionPlacement } from '../../src/renderer/src/lib/retire-moved-structured-session-placement'
import { restoredChatTabChanges } from '../../src/main/runtime/session-tabs/restored-chat-tab-changes'
import { structuredSessionPlacementAllowed } from '../../src/main/runtime/session-tabs/structured-session-placement'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'
import {
  retired,
  attachWindow,
  windowFrame,
  notes,
  resultAt,
  listAll,
  graphPublished,
  ids
} from './structured-session-placement.test-fixture'

vi.mock('../../src/main/claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
// The shipped layout owner: a window saves its own layout whole.
vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

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
      ...applyWebSessionTabsSnapshot(current, frame, PAIRED, NOW)
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
const withoutLabels = (rig: AuthorityRig & { old: string }) => {
  const saved = rig.profile.getWorkspaceSession('local')!
  rig.profile.setWorkspaceSession({
    ...saved,
    unifiedTabs: {
      ...saved.unifiedTabs,
      [rig.old]: saved.unifiedTabs![rig.old].map(({ agentSessionAgent: _label, ...tab }) => tab)
    }
  })
}
beforeEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

// K13. The reachable form of the K9 interleaving: C is restored by the production gate before any
// client reads, so the host holds its row. The out-of-contract form (a subscribed client while
// restoration never ran, no host C row) is evidence in ~/orca-qa/pr-37190/proofs-r6r/
// proof1-test.patch; it bypasses that gate and is not an accepted loss.
it.each(['the desktop opener prunes B first', 'only the phone moves B'] as const)(
  'K13: a move leaves the old workspace to its next ordinary publication, which keeps C and notes.md on every client when %s',
  async (variant) => {
    const rig = await retired([C], [B, C])
    attachWindow(rig)
    withoutLabels(rig)
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
    // The window shows B, C and notes.md there, and publishes its chats only as group order.
    const seeded = windowShowing(rig.old)
    useAppStore.setState({
      unifiedTabsByWorktree: seeded.unifiedTabsByWorktree,
      groupsByWorktree: {
        [rig.old]: [
          {
            id: 'window-group',
            worktreeId: rig.old,
            activeTabId: null,
            tabOrder: seeded.unifiedTabsByWorktree[rig.old]!.map((tab) => tab.id)
          }
        ]
      }
    })
    rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 7, [notes], [B, C])])
    graphPublished(rig)
    // The saved C carries no agent label, so its row can only come from its record.
    expect(
      rig.profile
        .getWorkspaceSession('local')!
        .unifiedTabs![rig.old].map((tab) => tab.agentSessionAgent)
    ).toEqual([undefined, undefined])
    const admitted = (await listAll(rig)).find((frame) => frame.worktree === rig.old)
    expect(ids(admitted)).toEqual([B, C, notes.id].sort())
    expect(chatsIn(admitted?.tabs, C)).toMatchObject([
      { agent: rig.store.getConversation(C)!.provider }
    ])
    const mirrored = pairedApply([admitted!])
    const window = localApply([admitted!], seeded)
    expect(shown(mirrored, rig.old)).toEqual([B, C, 'editor'])
    const acquired = rig.acquire.mock.calls.length
    const published: RuntimeMobileSessionTabsResult[] = []
    const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: rig.destination }
    })
    // Nothing is corrected at the move; until an ordinary publication, a mounted client keeps B.
    expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
    if (variant === 'the desktop opener prunes B first') {
      // The desktop opened B from its old address: the real owner-qualified prune of that one key.
      retireMovedSessionPlacement(B, rig.old, rig.destination, { kind: 'local' })
    }
    const listed = (useAppStore.getState().unifiedTabsByWorktree[rig.old] ?? [])
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => tab.entityId)
    expect(listed).toEqual(variant === 'only the phone moves B' ? [B, C] : [C])
    // The window's next graph lists its old workspace unchanged; the host's stale B row answers
    // with a resend request, and the window sends its full frame.
    const resync = new Set<string>()
    rig.runtime['syncMobileSessionTabs']([], [rig.old, rig.destination], resync)
    expect(resync.has(rig.old)).toBe(true)
    // The window answers every requested resend; the destination's lists B, as its layout does.
    expect(
      rig.runtime['syncMobileSessionTabs']([
        windowFrame(rig.old, 8, [notes], listed),
        ...(resync.has(rig.destination) ? [windowFrame(rig.destination, 1, [], [B])] : [])
      ]).has(rig.old)
    ).toBe(true)
    const settled = resultAt(rig, rig.old)
    const destination = resultAt(rig, rig.destination)
    expect(chatsIn(destination.tabs)).toHaveLength(1)
    const local = localApply([settled, destination], {
      ...window,
      unifiedTabsByWorktree: {
        ...window.unifiedTabsByWorktree,
        [rig.old]: useAppStore.getState().unifiedTabsByWorktree[rig.old] ?? []
      }
    })
    const paired = pairedApply([settled, destination], mirrored)
    expect({
      host: ids(settled),
      local: shown(local, rig.old),
      paired: shown(paired, rig.old)
    }).toEqual({
      host: [C, notes.id].sort(),
      local: [C, 'editor'],
      paired: [C, 'editor']
    })
    expect(shown(local, rig.destination)).toEqual([B])
    expect(shown(paired, rig.destination)).toEqual([B])
    // An already-current retry and the window's unchanged graph change nothing.
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: rig.destination }
    })
    const again = new Set<string>()
    rig.runtime['syncMobileSessionTabs']([], [rig.old, rig.destination], again)
    stop()
    expect([...again]).toEqual([])
    expect(resultAt(rig, rig.old)).toEqual(settled)
    expect(ids((await listAll(rig)).find((frame) => frame.worktree === rig.old))).toEqual(
      [C, notes.id].sort()
    )
    // Presentation never activates a provider.
    expect(rig.acquire.mock.calls.length - acquired).toBe(0)
  }
)

it('a subscriber gets no frame before startup restores the visible chats, even after the window lists C without a row', async () => {
  const rig = await retired([C], [B, C])
  attachWindow(rig)
  withoutLabels(rig)
  rig.runtime.mobileSessionTabsByWorktree.delete(rig.old)
  const release = await holdStartup(rig)
  // Early graph ingress: the window's frame lists C only as group order, before restoration.
  rig.runtime['syncMobileSessionTabs']([windowFrame(rig.old, 7, [notes], [C])])
  expect(chatsIn(resultAt(rig, rig.old).tabs, C)).toEqual([])
  graphPublished(rig)
  const messages: { type?: string; snapshots?: RuntimeMobileSessionTabsResult[] }[] = []
  const abort = new AbortController()
  const streaming = new RpcDispatcher({
    runtime: rig.runtime,
    methods: SESSION_TAB_METHODS
  }).dispatchStreaming(
    { id: 'phone-subscribe', authToken: 'token', method: 'session.tabs.subscribeAll', params: {} },
    (message) => {
      const parsed = JSON.parse(message) as { result?: (typeof messages)[number] }
      messages.push(parsed.result ?? {})
    },
    {
      clientKind: 'mobile',
      pairedDeviceId: 'phone',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      signal: abort.signal
    }
  )
  await chatTabCommandsSettled()
  expect(messages).toEqual([])
  await release()
  await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0))
  const [census] = messages
  expect(census.type).toBe('snapshots')
  // The census already holds the rows restoration projected from the records.
  expect(ids(census.snapshots?.find((frame) => frame.worktree === rig.old))).toEqual(
    [B, C, notes.id].sort()
  )
  abort.abort()
  await streaming
})

it('K10: a windowless host publishes nothing at the move; its next ordinary read shows the old workspace without B, keeping C', async () => {
  const rig = await retired([C], [B, C])
  withoutLabels(rig)
  graphPublished(rig)
  const before = (await listAll(rig)).find((frame) => frame.worktree === rig.old)!
  expect(ids(before)).toEqual([B, C])
  const mirrored = pairedApply([before])
  const published: RuntimeMobileSessionTabsResult[] = []
  const stop = rig.runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))
  expect(await reveal(rig)).toMatchObject({
    ok: true,
    result: { ok: true, workspaceId: rig.destination }
  })
  stop()
  expect(published.filter((snapshot) => snapshot.worktree === rig.old)).toEqual([])
  const after = await listAll(rig)
  const old = after.find((frame) => frame.worktree === rig.old)!
  expect(ids(old)).toEqual([C])
  expect(ids(after.find((frame) => frame.worktree === rig.destination))).toEqual([B])
  expect(shown(pairedApply([old], mirrored), rig.old)).toEqual([C])
  expect(shown(localApply([old], windowShowing(rig.old)), rig.old)).toEqual([C, 'editor'])
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
    // Every read of a row's own fields counts.
    const counted = <T extends object>(row: T): T => {
      const copy = { ...row }
      for (const [key, value] of Object.entries(row)) {
        Object.defineProperty(copy, key, {
          enumerable: true,
          get: () => {
            count++
            return value
          }
        })
      }
      return copy
    }
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

it('derives one stale frame of N moved chats in one pass at N and 10N, one record read per row', async () => {
  const rig = await retired()
  const record = rig.store.getRecord(B)!
  // Every chat in the frame belongs to the destination now.
  const reads = vi.spyOn(rig.store, 'getRecord').mockImplementation(() => ({
    ...record,
    location: { ...record.location, workspaceId: rig.destination }
  }))
  const readable = vi.spyOn(rig.store, 'isSessionUnreadable')
  const counts: { ids: number; records: number; readability: number }[] = []
  for (const n of [20, 200]) {
    let ids = 0
    reads.mockClear()
    readable.mockClear()
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
          ids++
          return `agent-session:chat-${i}`
        },
        sessionId: `chat-${i}`,
        title: 'Chat',
        agent: 'codex' as const,
        isActive: false
      }))
    }
    expect(rig.runtime['toMobileSessionTabsResult'](snapshot).tabs).toEqual([])
    counts.push({
      ids,
      records: reads.mock.calls.length,
      readability: readable.mock.calls.length
    })
  }
  // The placement work itself: one readability check and one record read per chat row.
  expect(counts.map(({ records, readability }) => [records, readability])).toEqual([
    [20, 20],
    [200, 200]
  ])
  expect(counts[1]!.ids).toBeLessThanOrEqual(12 * counts[0]!.ids)
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
