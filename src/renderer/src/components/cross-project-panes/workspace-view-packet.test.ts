import { describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { captureWorkspaceViews, importWorkspaceViews } from './workspace-view-packet'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { registerEditorView } from '../editor/editor-view-transfer'
import { getDiskBaselineSignature } from '../editor/diff-content-signature'

describe('workspace view packets', () => {
  it('imports into the previewed pane edge instead of the globally active pane', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: 'alpha' })
    store.getState().createUnifiedTab('alpha', 'terminal', { executionHostId: 'local' })
    store.getState().initializeWindowPanes()
    const initial = store.getState().windowPaneLayout!
    const packet = captureWorkspaceViews(store.getState(), Object.keys(initial.views), {
      local: 'owner'
    })
    store.getState().splitWindowPane(initial.activePaneId, 'horizontal')
    const patch = importWorkspaceViews(
      store.getState(),
      packet,
      'tabs',
      { local: 'owner' },
      { paneId: initial.activePaneId, zone: 'down' }
    )
    expect(Object.keys(patch.windowPaneLayout!.panes)).toHaveLength(3)
    expect(patch.windowPaneLayout!.root).toMatchObject({
      type: 'split',
      first: { type: 'split', direction: 'vertical' }
    })
  })
  it('resolves primary terminal identity in a secondary window without creating execution', () => {
    const source = createTestStore()
    const destination = createTestStore()
    source.setState({ activeWorktreeId: 'alpha' })
    const tab = source
      .getState()
      .createUnifiedTab('alpha', 'terminal', { executionHostId: 'local' })
    source.getState().initializeWindowPanes()
    const layout = source.getState().windowPaneLayout!
    const packet = captureWorkspaceViews(source.getState(), Object.keys(layout.views), {
      local: 'runtime-1'
    })
    const mirrored = destination.getState().createUnifiedTab('alpha', 'terminal', {
      executionHostId: 'runtime:loopback',
      entityId: toWebTerminalSurfaceTabId(tab.entityId)
    })
    const patch = importWorkspaceViews(destination.getState(), packet, 'tabs', {
      'runtime:loopback': 'runtime-1'
    })
    const imported = Object.values(patch.windowPaneLayout!.views)[0]
    expect(imported).toMatchObject({
      tabId: mirrored.id,
      entityId: mirrored.entityId,
      executionHostId: 'runtime:loopback'
    })
    expect(imported.id).not.toBe(Object.keys(layout.views)[0])
    expect(destination.getState().unifiedTabsByWorktree.alpha).toHaveLength(1)
  })

  it('refuses an unavailable owner before importing any of a combined window', () => {
    const source = createTestStore()
    source.setState({ activeWorktreeId: 'alpha' })
    source.getState().createUnifiedTab('alpha', 'terminal', { executionHostId: 'ssh:offline' })
    source.getState().initializeWindowPanes()
    const packet = captureWorkspaceViews(
      source.getState(),
      Object.keys(source.getState().windowPaneLayout!.views),
      { 'ssh:offline': 'owner' }
    )
    const destination = createTestStore()
    expect(() => importWorkspaceViews(destination.getState(), packet, 'panes', {})).toThrow(
      'Session unavailable'
    )
    expect(destination.getState().windowPaneLayout).toBeNull()
  })

  it('carries an empty unsaved editor draft and rejects conflicting destination edits', () => {
    const baseline = getDiskBaselineSignature('original disk text')
    const source = createTestStore()
    const destination = createTestStore()
    for (const store of [source, destination]) {
      store.setState({
        activeWorktreeId: 'alpha',
        openFiles: [
          {
            id: '/alpha/draft.txt',
            filePath: '/alpha/draft.txt',
            relativePath: 'draft.txt',
            worktreeId: 'alpha',
            language: 'plaintext',
            mode: 'edit',
            isDirty: true,
            lastKnownDiskSignature: baseline
          }
        ]
      })
      store.getState().createUnifiedTab('alpha', 'editor', {
        executionHostId: 'local',
        entityId: '/alpha/draft.txt'
      })
      store.getState().initializeWindowPanes()
    }
    source.setState({ editorDrafts: { '/alpha/draft.txt': '' } })
    const packet = captureWorkspaceViews(
      source.getState(),
      Object.keys(source.getState().windowPaneLayout!.views),
      { local: 'runtime-1' }
    )
    destination.setState({ editorDrafts: { '/alpha/draft.txt': 'different unsaved text' } })
    expect(() =>
      importWorkspaceViews(destination.getState(), packet, 'tabs', { local: 'runtime-1' })
    ).toThrow('Unsaved destination')
    destination.setState({ editorDrafts: {} })
    const patch = importWorkspaceViews(destination.getState(), packet, 'tabs', {
      local: 'runtime-1'
    })
    expect(patch.editorDrafts).toEqual({ '/alpha/draft.txt': '' })
    expect(patch.openFiles?.[0]).toMatchObject({
      isDirty: true,
      lastKnownDiskSignature: baseline
    })
    const destinationViewId = Object.keys(destination.getState().windowPaneLayout!.views)[0]
    let liveText = 'original disk text'
    const dispose = registerEditorView(destinationViewId, () => ({
      text: liveText,
      version: 2,
      state: null
    }))
    expect(() =>
      importWorkspaceViews(destination.getState(), packet, 'tabs', { local: 'runtime-1' })
    ).not.toThrow()
    liveText = 'typed before the draft debounce'
    destination.setState({
      openFiles: destination.getState().openFiles.map((file) => ({ ...file, isDirty: false }))
    })
    expect(() =>
      importWorkspaceViews(destination.getState(), packet, 'tabs', { local: 'runtime-1' })
    ).toThrow('Unsaved destination')
    dispose()
  })
})
