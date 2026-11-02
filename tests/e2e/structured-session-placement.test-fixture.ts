import { expect, vi } from 'vitest'
import {
  root,
  B,
  openAuthorityRuntime,
  inWorkspace,
  type AuthorityRig
} from '../../src/main/runtime/structured-agent-session-tab-authority.test-support'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../src/main/runtime/rpc/methods/session-tabs'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../src/shared/agent-session/agent-session-runtime-capabilities'
import { storeRepo } from '../../src/main/runtime/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import { withChatTabChanges } from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { getRepoMainWorktreeId } from '../../src/shared/worktree/id'
import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'

/** B, and any `kept` chats, live in a workspace whose registration is gone; `visible` chats show. */
export async function retired(kept: string[] = [], visible = kept) {
  const old = `retired-project::${root}`
  const input = await inWorkspace(old, 'folder', 'local', visible)
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
export const attachWindow = (rig: AuthorityRig) =>
  vi.spyOn(rig.runtime, 'getAvailableAuthoritativeWindow' as never).mockReturnValue({
    id: 1,
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  } as never)

// A window's own frame for a workspace: its non-chat rows, and its chats only as group order.
export const windowFrame = (
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
export const notes: RuntimeMobileSessionFileTab = {
  type: 'file',
  id: 'notes-tab',
  title: 'notes.md',
  filePath: '/project/notes.md',
  relativePath: 'notes.md',
  language: 'markdown',
  isDirty: false,
  isActive: false
}

export const resultAt = (rig: AuthorityRig, workspace: string) =>
  rig.runtime['toMobileSessionTabsResult'](rig.runtime.mobileSessionTabsByWorktree.get(workspace)!)

// The real public read: the production restore gate runs before any inventory is collected.
export const listAll = async (rig: AuthorityRig) => {
  const response = await new RpcDispatcher({
    runtime: rig.runtime,
    methods: SESSION_TAB_METHODS
  }).dispatch(
    { id: 'phone-list', authToken: 'token', method: 'session.tabs.listAll', params: null },
    {
      clientKind: 'mobile',
      pairedDeviceId: 'phone',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
  )
  expect(response).toMatchObject({ ok: true })
  return (response as { result: { snapshots: RuntimeMobileSessionTabsResult[] } }).result.snapshots
}
// The window's graph has published once, so inventory reads wait only on chat restoration.
export const graphPublished = (rig: AuthorityRig) => {
  rig.runtime['graphStatus'] = 'ready'
  rig.runtime['markSessionTabsInventoryPublished']()
}
export const ids = (frame: RuntimeMobileSessionTabsResult | undefined) =>
  (frame?.tabs ?? []).map((tab) => (tab.type === 'agent-session' ? tab.sessionId : tab.id)).sort()
