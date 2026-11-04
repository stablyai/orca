// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

vi.mock('./ExternalFileChangeBanner', () => ({
  ExternalFileChangeBanner: () => <div>banner</div>
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))

import { CustomEditorExternalChangeBanner } from './CustomEditorExternalChangeBanner'
import {
  countCustomEditorMergingView,
  mergeOutsideChangeIntoEditor,
  recordCustomEditorAncestor,
  useCustomEditorOutsideMergeStore
} from './use-custom-editor-outside-merge'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const initialState = useAppStore.getState()
const FILE_ID = '/repo/board.sketch'

function openTab(baseline: string): void {
  useAppStore.getState().openFile({
    filePath: FILE_ID,
    relativePath: 'board.sketch',
    worktreeId: 'wt-1',
    language: 'plaintext',
    mode: 'edit'
  })
  useAppStore.getState().markFileDirty(FILE_ID, true)
  useAppStore.getState().setLastKnownDiskSignature(FILE_ID, getDiskBaselineSignature(baseline))
  useAppStore.getState().setExternalMutation(FILE_ID, 'changed')
}

const tab = (): OpenFile | undefined =>
  useAppStore.getState().openFiles.find((file) => file.id === FILE_ID)

/** One merging view of a local tab whose edits started from `a`. */
function ready(): void {
  openTab('a')
  recordCustomEditorAncestor(FILE_ID, 'a')
  countCustomEditorMergingView(FILE_ID, 1)
}

const afterSaved: (() => void)[] = []

afterEach(() => {
  afterSaved.splice(0).forEach((stop) => stop())
  useAppStore.setState(initialState, true)
  useCustomEditorOutsideMergeStore.setState({ views: {}, busy: {}, ancestors: {} })
})

describe('custom editor outside merge', () => {
  it('stamps exactly the disk snapshot the acknowledged merge used, and advances the ancestor', async () => {
    ready()
    // The tab's saved text moves to the disk text the merge used, as the panel hears after a save.
    const saved: unknown[] = []
    const onSaved = (event: Event): void => {
      saved.push(event instanceof CustomEvent ? event.detail : null)
    }
    window.addEventListener('orca:editor-file-saved', onSaved)
    afterSaved.push(() => window.removeEventListener('orca:editor-file-saved', onSaved))
    const host = { mergeOutsideChange: vi.fn().mockResolvedValue('a+mine+agent') }
    await expect(mergeOutsideChangeIntoEditor(FILE_ID, host, async () => 'a+agent')).resolves.toBe(
      true
    )
    expect(host.mergeOutsideChange).toHaveBeenCalledWith('a+agent', 'a')
    expect(tab()?.externalMutation).toBeUndefined()
    expect(tab()?.lastKnownDiskSignature).toBe(getDiskBaselineSignature('a+agent'))
    expect(useCustomEditorOutsideMergeStore.getState().ancestors[FILE_ID]?.text).toBe('a+agent')
    expect(saved).toEqual([{ fileId: FILE_ID, content: 'a+agent', recordViewIds: [FILE_ID] }])
  })

  it('puts the conflict back for a write that landed while the merge ran', async () => {
    ready()
    const reads = ['a+agent', 'a+agent+second']
    const host = { mergeOutsideChange: vi.fn().mockResolvedValue('merged') }
    await mergeOutsideChangeIntoEditor(FILE_ID, host, async () => reads.shift() ?? null)
    // Only the first write is stamped; the second waits for its own merge.
    expect(tab()).toMatchObject({
      externalMutation: 'changed',
      lastKnownDiskSignature: getDiskBaselineSignature('a+agent')
    })
  })

  it('keeps the conflict for the banner when the session never acknowledges', async () => {
    ready()
    const host = { mergeOutsideChange: vi.fn().mockResolvedValue(null) }
    await expect(mergeOutsideChangeIntoEditor(FILE_ID, host, async () => 'a+agent')).resolves.toBe(
      false
    )
    expect(tab()).toMatchObject({
      externalMutation: 'changed',
      lastKnownDiskSignature: getDiskBaselineSignature('a')
    })
    expect(useCustomEditorOutsideMergeStore.getState().busy[FILE_ID]).toBeUndefined()
  })

  it('leaves it to the banner with no known ancestor, or two editor views', async () => {
    const host = { mergeOutsideChange: vi.fn().mockResolvedValue('x') }
    openTab('a')
    countCustomEditorMergingView(FILE_ID, 1)
    // The recorded ancestor is not the disk the tab's baseline names.
    recordCustomEditorAncestor(FILE_ID, 'older')
    await expect(mergeOutsideChangeIntoEditor(FILE_ID, host, async () => 'b')).resolves.toBe(false)
    recordCustomEditorAncestor(FILE_ID, 'a')
    countCustomEditorMergingView(FILE_ID, 1)
    await expect(mergeOutsideChangeIntoEditor(FILE_ID, host, async () => 'b')).resolves.toBe(false)
    expect(host.mergeOutsideChange).not.toHaveBeenCalled()
  })

  it('hides the banner only while a merge runs', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the banner gate reads only the tab's id.
    const file = { id: FILE_ID } as OpenFile
    await act(async () =>
      root.render(
        <CustomEditorExternalChangeBanner file={file} currentContent="x" reloadContent={vi.fn()} />
      )
    )
    expect(container.textContent).toBe('banner')
    await act(async () => useCustomEditorOutsideMergeStore.setState({ busy: { [FILE_ID]: true } }))
    expect(container.textContent).toBe('')
    await act(async () => root.unmount())
  })
})
