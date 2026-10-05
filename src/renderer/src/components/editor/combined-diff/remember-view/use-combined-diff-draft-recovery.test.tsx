// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type * as EditorFileOwnerModule from '@/lib/editor-file-operation-owner'
import type { EditorRecoveryApi } from '../../../../../../shared/editor-recovery'
import { createEditorRecoverySubscriber } from '@/lib/editor-recovery-subscriber'
import { getExternalRecoveryBuffers } from '@/lib/editor-recovery-external-buffers'
import { getDiskBaselineSignature } from '../../diff-content-signature'
import type { DiffSection } from '../../diff-section-types'
import { useCombinedDiffDraftRecovery } from './use-combined-diff-draft-recovery'
import { useCombinedDiffSectionActions } from '../review-controls/use-combined-diff-section-actions'

const io = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({ writeRuntimeFile: io.write }))
vi.mock('@/lib/editor-file-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorFileOwnerModule>()),
  getEditorFileOperationContext: () => ({})
}))

const parent: OpenFile = {
  id: 'combined-view',
  filePath: '/repo',
  relativePath: 'Changes',
  worktreeId: 'wt',
  language: 'plaintext',
  mode: 'diff',
  diffSource: 'combined-uncommitted',
  isDirty: false
}
function section(content = 'baseline'): DiffSection {
  return {
    key: 'unstaged:note.txt',
    path: 'note.txt',
    status: 'M',
    area: 'unstaged',
    originalContent: 'committed',
    modifiedContent: content,
    collapsed: false,
    loading: false,
    dirty: content !== 'baseline',
    largeDiffRenderLimit: null,
    diffResult: {
      kind: 'text',
      originalContent: 'committed',
      modifiedContent: 'baseline',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}
let original: AppState
let subscriber: ReturnType<typeof createEditorRecoverySubscriber>
const apply = vi.fn<EditorRecoveryApi['apply']>()
beforeEach(() => {
  original = useAppStore.getState()
  vi.useFakeTimers()
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    openFiles: [],
    editorDrafts: {}
  })
  apply.mockImplementation(async (changes) =>
    changes.map((change) => ({ id: change.id, revision: change.expectedRevision + 1 }))
  )
  subscriber = createEditorRecoverySubscriber({
    store: useAppStore,
    flushPendingChanges: () => {},
    onError: vi.fn(),
    api: { apply, list: async () => [], read: async () => null, export: async () => null }
  })
})
afterEach(() => {
  cleanup()
  subscriber.dispose()
  useAppStore.setState(original, true)
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('combined view drafts in the shared journal', () => {
  it('captures the final model event before unmount and retains the remote-owned draft', async () => {
    const hook = renderHook(() =>
      useCombinedDiffDraftRecovery({ ...parent, externalSshTargetId: 'remote' }, [])
    )
    act(() => hook.result.current.onDraftChange(section(), 'final text before closing'))
    hook.unmount()
    await subscriber.flush()
    expect(apply.mock.calls.flatMap(([changes]) => changes)).toEqual([
      expect.objectContaining({
        kind: 'put',
        state: 'retained',
        content: 'final text before closing',
        metadata: expect.objectContaining({
          hostId: 'ssh:remote',
          filePath: '/repo/note.txt',
          bufferKind: 'diff',
          lastKnownDiskSignature: getDiskBaselineSignature('baseline')
        })
      })
    ])
    expect(getExternalRecoveryBuffers()).toEqual([])
  })

  it('ignores immutable sections and fences a matching save before the first checkpoint', async () => {
    const hook = renderHook(() => useCombinedDiffDraftRecovery(parent, []))
    act(() => hook.result.current.onDraftChange({ ...section(), area: 'staged' }, 'staged text'))
    await subscriber.flush()
    expect(apply).not.toHaveBeenCalled()
    act(() => hook.result.current.onDraftChange(section(), 'saved text'))
    await act(() => hook.result.current.retireSection(section().key, 'saved text'))
    expect(apply.mock.calls.flatMap(([changes]) => changes)).toEqual([
      expect.objectContaining({ kind: 'resolve', expectedRevision: 0 })
    ])
    expect(getExternalRecoveryBuffers()).toEqual([])
  })

  it('keeps edits made during a pending section save in both the viewer and its backup', async () => {
    let finish: (() => void) | undefined
    io.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const hook = renderHook(() => {
      const [sections, setSections] = useState([section('first edit')])
      const sectionsRef = useRef(sections)
      sectionsRef.current = sections
      const recovery = useCombinedDiffDraftRecovery(parent, sections)
      const actions = useCombinedDiffSectionActions({
        file: parent,
        sections,
        sectionsRef,
        setSections,
        activeGroupId: undefined,
        branchCompare: null,
        commitCompare: null,
        isAllMode: false,
        isBranchMode: false,
        isCommitMode: false,
        canOpenWorkspaceFileBrowserForPath: () => false,
        setSectionHeights: () => {},
        retireSection: recovery.retireSection
      })
      return { sections, setSections, recovery, actions }
    })
    let saved: Promise<void> | undefined
    act(() => {
      saved = hook.result.current.actions.handleSectionSaveRef.current(0)
    })
    await subscriber.flush()
    act(() => {
      hook.result.current.recovery.onDraftChange(section('first edit'), 'newer during write')
      hook.result.current.setSections([section('newer during write')])
    })
    if (!finish || !saved) {
      throw new Error('Section write was not dispatched')
    }
    await act(async () => {
      finish?.()
      await saved
    })
    await subscriber.flush()
    expect(hook.result.current.sections[0]).toMatchObject({
      modifiedContent: 'newer during write',
      dirty: true,
      diffResult: { modifiedContent: 'first edit' }
    })
    expect(apply.mock.calls.flatMap(([changes]) => changes).at(-1)).toMatchObject({
      kind: 'put',
      content: 'newer during write',
      state: 'active'
    })
    expect(
      apply.mock.calls.flatMap(([changes]) => changes).some((change) => change.kind === 'resolve')
    ).toBe(false)
  })
})
