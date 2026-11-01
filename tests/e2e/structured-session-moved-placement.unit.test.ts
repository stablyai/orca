import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  root,
  B,
  openAuthorityRuntime,
  reveal,
  inWorkspace,
  physicalReload,
  type AuthorityRig
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { withChatTabChanges } from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { getRepoMainWorktreeId } from '../../src/shared/worktree/id'

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

const savedAt = (rig: AuthorityRig, workspace: string) =>
  (rig.profile.getWorkspaceSession('local')?.unifiedTabs?.[workspace] ?? []).filter(
    (tab) => tab.entityId === B
  )
const rawAt = (rig: AuthorityRig, workspace: string) =>
  (rig.runtime.mobileSessionTabsByWorktree.get(workspace)?.tabs ?? []).filter(
    (tab) => tab.type === 'agent-session' && tab.sessionId === B
  )

it('a phone move the attached window still shows stays moved after the old registration returns and Orca restarts', async () => {
  const rig = await retired()
  const window = attachWindow(rig)
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await reveal(rig)).toMatchObject({
      ok: true,
      result: { ok: true, workspaceId: rig.destination }
    })
  }
  expect(rawAt(rig, rig.old)).toEqual([])
  expect(rawAt(rig, rig.destination)).toHaveLength(1)
  // The window owns the saved layout, so the old tab is still saved when it goes away.
  expect(savedAt(rig, rig.old)).toHaveLength(1)
  window.mockRestore()
  rig.profile.addRepo(storeRepo({ id: 'retired-project', path: root, kind: 'folder' }))
  const fresh = await physicalReload(rig)
  expect(fresh.store.getRecord(B)?.location.workspaceId).toBe(rig.destination)
  expect(savedAt(fresh, rig.old)).toEqual([])
  expect(rawAt(fresh, rig.old)).toEqual([])
})

it('a delayed old-workspace frame and the empty frame after it cannot bring the moved chat back', async () => {
  const rig = await retired()
  rig.runtime.projectStructuredAgentSessionTab({
    workspaceId: rig.old,
    sessionId: B,
    agent: rig.store.getRecord(B)!.provider,
    activate: false
  })
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
  expect(rawAt(rig, rig.old)).toEqual([])
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
  expect(rawAt(rig, rig.old)).toEqual([])
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
