import { describe, expect, it } from 'vitest'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createTestStore } from '../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { mainLoadedLayouts } from './main-loaded-layout-frames.test-fixture'
import { fullLayoutFrameBuildPatch } from './workspace-layout-frame-builds'
import { NO_HELD_TABS } from '../store/workspace-layout-frame-held-tabs'
import { createNativeDesktopFrameEdits } from './native-desktop-frame-edits'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'

createStoreSessionMockApi()

describe('native window pending layout edits', () => {
  it.each(
    [false, true].flatMap((dirtyFlag) =>
      [false, true].map((replacesGroup) => ({ dirtyFlag, replacesGroup }))
    )
  )(
    'retains a draft after peer close with dirty flag $dirtyFlag and replacement group $replacesGroup',
    async ({ dirtyFlag, replacesGroup }) => {
      const session = localDesktopSession()
      const store = createTestStore()
      await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
      const localEdits = createNativeDesktopFrameEdits(store.getState())
      const holds = {
        held: NO_HELD_TABS,
        keepsTerminalLayout: () => false,
        newRowFields: () => null,
        localEdits
      }
      const cache = mainLoadedLayouts('local', session)
      store.setState(fullLayoutFrameBuildPatch(store.getState(), cache, [GIT_KEY], holds))
      const file = store.getState().openFiles[0]!
      store.getState().setEditorDraft(file.id, 'Unsaved native peer draft')
      store.getState().markFileDirty(file.id, dirtyFlag)
      const tab = store
        .getState()
        .unifiedTabsByWorktree[GIT_KEY]!.find((entry) => entry.entityId === file.id)!
      const peer = structuredClone(cache)
      peer[GIT_KEY]!.tabs = peer[GIT_KEY]!.tabs.filter((entry) => entry.id !== tab.id)
      for (const group of peer[GIT_KEY]!.groups) {
        group.tabIds = group.tabIds.filter((id) => id !== tab.id)
      }
      if (replacesGroup) {
        peer[GIT_KEY]!.groups.find((group) => group.id === tab.groupId)!.id = 'peer-new-group'
        peer[GIT_KEY]!.groupLayout = {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-b' },
          second: { type: 'leaf', groupId: 'peer-new-group' }
        }
      }
      store.setState(fullLayoutFrameBuildPatch(store.getState(), peer, [GIT_KEY], holds))
      expect(store.getState().unifiedTabsByWorktree[GIT_KEY]).toContainEqual(
        expect.objectContaining({ id: tab.id })
      )
      expect(store.getState().openFiles).toContainEqual(expect.objectContaining({ id: file.id }))
      expect(store.getState().editorDrafts[file.id]).toBe('Unsaved native peer draft')
      if (replacesGroup) {
        expect(store.getState().layoutByWorktree[GIT_KEY]).toEqual(peer[GIT_KEY]!.groupLayout)
        expect(
          store
            .getState()
            .groupsByWorktree[GIT_KEY]?.map((group) => group.id)
            .sort()
        ).toEqual(['group-b', 'peer-new-group'])
        expect(
          store.getState().unifiedTabsByWorktree[GIT_KEY]?.find((entry) => entry.id === tab.id)
            ?.groupId
        ).not.toBe(tab.groupId)
      }
      store.getState().markFileDirty(file.id, true)
      expect(
        buildWorkspaceSessionPayload(store.getState()).openFilesByWorktree?.[GIT_KEY]
      ).toContainEqual(expect.objectContaining({ dirtyDraftContent: 'Unsaved native peer draft' }))
    }
  )

  it.each([false, true])(
    'accepts a peer reorder while the local window only changes a label: %s',
    async (rename) => {
      const session = localDesktopSession()
      const store = createTestStore()
      await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
      const localEdits = createNativeDesktopFrameEdits(store.getState())
      const holds = {
        held: NO_HELD_TABS,
        keepsTerminalLayout: () => false,
        newRowFields: () => null,
        localEdits
      }
      const cache = mainLoadedLayouts('local', session)
      store.setState(fullLayoutFrameBuildPatch(store.getState(), cache, [GIT_KEY], holds))
      if (rename) {
        store.getState().setTabCustomLabel('tab-shell', 'Local label')
      }
      const peer = structuredClone(cache)
      const group = peer[GIT_KEY]!.groups[0]!
      group.tabIds = group.tabIds.toReversed()
      store.setState(fullLayoutFrameBuildPatch(store.getState(), peer, [GIT_KEY], holds))
      expect(
        store.getState().groupsByWorktree[GIT_KEY]!.find((candidate) => candidate.id === group.id)
          ?.tabOrder
      ).toEqual(group.tabIds)
      const saved = buildWorkspaceSessionPayload(store.getState())
      expect(
        saved.tabGroups?.[GIT_KEY]?.find((candidate) => candidate.id === group.id)?.tabOrder
      ).toEqual(group.tabIds)
      if (rename) {
        expect(
          saved.unifiedTabs?.[GIT_KEY]?.find((tab) => tab.id === 'tab-shell')?.customLabel
        ).toBe('Local label')
      }
    }
  )

  it('keeps a newly opened browser and its page when an earlier peer frame arrives before its save', async () => {
    const session = localDesktopSession()
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
    const localEdits = createNativeDesktopFrameEdits(store.getState())
    const holds = {
      held: NO_HELD_TABS,
      keepsTerminalLayout: () => false,
      newRowFields: () => null,
      localEdits
    }
    const cache = mainLoadedLayouts('local', session)
    store.setState(fullLayoutFrameBuildPatch(store.getState(), cache, [GIT_KEY], holds))
    const tab = store
      .getState()
      .createBrowserTab(GIT_KEY, 'https://example.test', { activate: true })
    const pages = store.getState().browserPagesByWorkspace[tab.id]
    store.setState(fullLayoutFrameBuildPatch(store.getState(), cache, [GIT_KEY], holds))
    expect(store.getState().browserTabsByWorktree[GIT_KEY]?.some((row) => row.id === tab.id)).toBe(
      true
    )
    expect(store.getState().browserPagesByWorkspace[tab.id]).toEqual(pages)
  })
  it('keeps an unsaved rename and reorder while another window saves a change first', async () => {
    const session = localDesktopSession()
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
    const localEdits = createNativeDesktopFrameEdits(store.getState())
    const holds = {
      held: NO_HELD_TABS,
      keepsTerminalLayout: () => false,
      newRowFields: () => null,
      localEdits
    }
    const cache = mainLoadedLayouts('local', session)
    store.setState(fullLayoutFrameBuildPatch(store.getState(), cache, [GIT_KEY], holds))
    store.getState().setTabCustomLabel('tab-shell', 'Window A rename')
    const group = store.getState().groupsByWorktree[GIT_KEY]![0]!
    store.getState().reorderUnifiedTabs(group.id, group.tabOrder.toReversed())
    const localOrder = store
      .getState()
      .groupsByWorktree[GIT_KEY]!.find((candidate) => candidate.id === group.id)!.tabOrder
    const peer = structuredClone(cache)
    const peerShell = peer[GIT_KEY]!.tabs.find((tab) => tab.entityId === 'tab-shell')!
    peerShell.color = '#008800'
    store.setState(fullLayoutFrameBuildPatch(store.getState(), peer, [GIT_KEY], holds))
    expect(
      store.getState().unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')
    ).toMatchObject({ customLabel: 'Window A rename', color: '#008800' })
    expect(
      store.getState().groupsByWorktree[GIT_KEY]!.find((candidate) => candidate.id === group.id)!
        .tabOrder
    ).toEqual(localOrder)
    const saved = buildWorkspaceSessionPayload(store.getState())
    expect(saved.unifiedTabs?.[GIT_KEY]?.find((tab) => tab.id === 'tab-shell')).toMatchObject({
      customLabel: 'Window A rename',
      color: '#008800'
    })
    const echoed = mainLoadedLayouts('local', saved)
    store.setState(fullLayoutFrameBuildPatch(store.getState(), echoed, [GIT_KEY], holds))
    const next = structuredClone(echoed)
    next[GIT_KEY]!.tabs.find((tab) => tab.entityId === 'tab-shell')!.customTitle =
      'Later peer rename'
    store.setState(fullLayoutFrameBuildPatch(store.getState(), next, [GIT_KEY], holds))
    expect(
      store.getState().unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.id === 'tab-shell')
        ?.customLabel
    ).toBe('Later peer rename')
  })
})
