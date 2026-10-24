// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { OpenFilePathRekey } from './editor'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

// Switch on: main renames the tabs, and its frame rekeys the content (T1 transport, apply mode).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

let main: TabsDrawnFromMain

/** The rekey once every open is drawn, then main's answer and the frame that carries it. */
async function rekey(
  args: Parameters<AppState['rekeyOpenFilesForPathChange']>[0]
): Promise<ReturnType<AppState['rekeyOpenFilesForPathChange']>> {
  await main.settle()
  const result = useAppStore.getState().rekeyOpenFilesForPathChange(args)
  await main.settle()
  return result
}

// Stage-1 foundation: rekeyOpenFilesForPathChange atomically retargets an open
// edit session across an Orca-owned move (no close/reopen), preserving all
// id-keyed state and failing closed on collision/stale without mutating.

function seedEditTab(overrides: Partial<Record<string, unknown>> = {}): void {
  const state = useAppStore.getState()
  state.openFile(
    {
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  const id = useAppStore.getState().openFiles[0]!.id
  state.setEditorDraft(id, '20 min of work')
  state.markFileDirty(id, true)
  state.setLastKnownDiskSignature(id, 'sig-a')
  useAppStore.setState((s) => ({
    editorCursorLine: { ...s.editorCursorLine, [id]: 42 },
    markdownViewMode: { ...s.markdownViewMode, [id]: 'rendered' } as never,
    activeFileId: id,
    activeFileIdByWorktree: { ...s.activeFileIdByWorktree, 'wt-1': id },
    tabBarOrderByWorktree: { ...s.tabBarOrderByWorktree, 'wt-1': [id] },
    ...overrides
  }))
}

function rekeyFor(oldId: string, newPath: string, newRel: string): OpenFilePathRekey {
  return {
    oldFileId: oldId,
    newFileId: newPath, // path-derived id for a local tab
    oldFilePath: '/repo/a.md',
    newFilePath: newPath,
    newRelativePath: newRel
  }
}

describe('rekeyOpenFilesForPathChange', () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    main = await drawTabsFromMain(useAppStore)
  })

  afterEach(() => main.close())

  it('retargets the session preserving draft, dirty, baseline, cursor, view, active, tab bar', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    const newPath = '/repo/sub/a.md'

    const result = await rekey({
      rekeys: [rekeyFor(oldId, newPath, 'sub/a.md')]
    })

    expect(result).toEqual({ ok: true })
    const s = useAppStore.getState()
    const moved = s.openFiles[0]!
    expect(moved.id).toBe(newPath)
    expect(moved.filePath).toBe(newPath)
    expect(moved.relativePath).toBe('sub/a.md')
    expect(moved.isDirty).toBe(true)
    expect(moved.lastKnownDiskSignature).toBe('sig-a')
    // id-keyed state migrated to the new id, old key gone.
    expect(s.editorDrafts[newPath]).toBe('20 min of work')
    expect(s.editorDrafts[oldId]).toBeUndefined()
    expect(s.editorCursorLine[newPath]).toBe(42)
    expect(s.editorCursorLine[oldId]).toBeUndefined()
    expect(s.markdownViewMode[newPath]).toBe('rendered')
    expect(s.activeFileId).toBe(newPath)
    expect(s.activeFileIdByWorktree['wt-1']).toBe(newPath)
    expect(s.tabBarOrderByWorktree['wt-1']).toEqual([newPath])
  })

  it('migrates unified tab entityId/id and group order', async () => {
    seedEditTab()
    await main.settle()
    const oldId = useAppStore.getState().openFiles[0]!.id
    // Switch on, main's frame drew the tab under its own id; off, a tab keyed by its file's id.
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      const tab: Tab = {
        id: oldId,
        entityId: oldId,
        contentType: 'editor',
        groupId: 'g1',
        title: 'a.md'
      } as never
      const group: TabGroup = {
        id: 'g1',
        tabOrder: [oldId],
        activeTabId: oldId,
        recentTabIds: [oldId]
      } as never
      useAppStore.setState({
        unifiedTabsByWorktree: { 'wt-1': [tab] },
        groupsByWorktree: { 'wt-1': [group] }
      } as never)
    }
    const tabBefore = useAppStore.getState().unifiedTabsByWorktree['wt-1']![0]!
    const newPath = '/repo/sub/a.md'
    const movedTabId = tabBefore.id === oldId ? newPath : tabBefore.id

    await rekey({
      rekeys: [rekeyFor(oldId, newPath, 'sub/a.md')]
    })

    const s = useAppStore.getState()
    const movedTab = s.unifiedTabsByWorktree['wt-1']![0]!
    expect(movedTab.entityId).toBe(newPath)
    expect(movedTab.id).toBe(movedTabId)
    const movedGroup = s.groupsByWorktree['wt-1']![0]!
    expect(movedGroup.tabOrder).toEqual([movedTabId])
    expect(movedGroup.activeTabId).toBe(movedTabId)
    expect(movedGroup.recentTabIds).toEqual([movedTabId])
  })

  it('rejects a collision with a distinct live session and mutates nothing', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    // A second, unrelated open tab already lives at the destination id.
    useAppStore.getState().openFile(
      {
        filePath: '/repo/sub/a.md',
        relativePath: 'sub/a.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const before = useAppStore.getState().openFiles.map((f) => f.id)

    const result = await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')]
    })

    expect(result).toEqual({ ok: false, reason: 'collision' })
    expect(useAppStore.getState().openFiles.map((f) => f.id)).toEqual(before)
  })

  it('reports stale when a source id is no longer open, mutating nothing', async () => {
    seedEditTab()
    const before = useAppStore.getState().openFiles.map((f) => f.id)

    const result = await rekey({
      rekeys: [rekeyFor('editor:gone', '/repo/sub/a.md', 'sub/a.md')]
    })

    expect(result).toEqual({ ok: false, reason: 'stale' })
    expect(useAppStore.getState().openFiles.map((f) => f.id)).toEqual(before)
  })

  it('consumes untitled status on an explicit rename', async () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit',
        isUntitled: true
      },
      { suppressActiveRuntimeFallback: true }
    )
    const oldId = useAppStore.getState().openFiles[0]!.id

    await rekey({
      rekeys: [
        {
          oldFileId: oldId,
          newFileId: '/repo/named.md',
          oldFilePath: '/repo/untitled.md',
          newFilePath: '/repo/named.md',
          newRelativePath: 'named.md',
          consumeUntitled: true
        }
      ]
    })

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.isUntitled).toBeUndefined()
    expect(moved.filePath).toBe('/repo/named.md')
  })

  it('installs the move-echo provenance on a dirty destination when moveOperationId is set', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    const newPath = '/repo/sub/a.md'

    await rekey({
      rekeys: [rekeyFor(oldId, newPath, 'sub/a.md')],
      moveOperationId: 'op-42'
    })

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.pendingSelfMoveEcho).toEqual({ operationId: 'op-42', targetPath: newPath })
  })

  it('does not verify a tab already showing the changed-on-disk banner', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    // A dirty tab that already conflicts with disk keeps its banner.
    useAppStore.getState().setExternalMutation(oldId, 'changed')

    await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')],
      moveOperationId: 'op-42'
    })

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.externalMutation).toBe('changed')
    expect(moved.pendingSelfMoveEcho).toBeUndefined()
  })

  it('migrates a pending editor reveal keyed by fileId to the new tab id', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    useAppStore.setState({
      pendingEditorReveal: { fileId: oldId, filePath: '/repo/a.md', line: 40, requestId: 1 }
    } as never)

    await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')]
    })

    const reveal = useAppStore.getState().pendingEditorReveal!
    expect(reveal.fileId).toBe(useAppStore.getState().openFiles[0]!.id)
    expect(reveal.filePath).toBe('/repo/sub/a.md')
  })

  it('does not verify a clean destination', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    useAppStore.getState().markFileDirty(oldId, false)

    await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')],
      moveOperationId: 'op-42'
    })

    const moved = useAppStore.getState().openFiles[0]!
    expect(moved.pendingSelfMoveEcho).toBeUndefined()
  })

  it('detaches a moved tab from the host mirror so the snapshot cannot cull it', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    useAppStore.setState((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.id === oldId ? { ...f, mirroredFromRuntimeSession: true } : f
      )
    }))

    await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')]
    })

    expect(useAppStore.getState().openFiles[0]!.mirroredFromRuntimeSession).toBeUndefined()
  })

  it('leaves a reveal keyed by another worktree file id untouched when only the path matches', async () => {
    seedEditTab()
    // A same-path tab in a second worktree: the reveal belongs to it, not to the rekeyed tab.
    useAppStore.getState().openFile(
      {
        filePath: '/repo/a.md',
        relativePath: 'a.md',
        worktreeId: 'wt-2',
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    const rekeyedId = useAppStore.getState().openFiles[0]!.id
    const otherWorktreeId = useAppStore.getState().openFiles[1]!.id
    expect(otherWorktreeId).not.toBe(rekeyedId)
    useAppStore.setState({
      pendingEditorReveal: { fileId: otherWorktreeId, filePath: '/repo/a.md', line: 40 }
    } as never)

    const result = await rekey({
      rekeys: [rekeyFor(rekeyedId, '/repo/sub/a.md', 'sub/a.md')]
    })

    expect(result).toEqual({ ok: true })
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === '/repo/sub/a.md')
    ).toMatchObject({ filePath: '/repo/sub/a.md' })
    const reveal = useAppStore.getState().pendingEditorReveal!
    expect(reveal.fileId).toBe(otherWorktreeId)
    expect(reveal.filePath).toBe('/repo/a.md')
  })

  it('migrates a pending editor reveal to the new path', async () => {
    seedEditTab()
    const oldId = useAppStore.getState().openFiles[0]!.id
    useAppStore.setState({
      pendingEditorReveal: { filePath: '/repo/a.md', requestId: 1 }
    } as never)

    await rekey({
      rekeys: [rekeyFor(oldId, '/repo/sub/a.md', 'sub/a.md')]
    })

    expect(useAppStore.getState().pendingEditorReveal?.filePath).toBe('/repo/sub/a.md')
  })
})
