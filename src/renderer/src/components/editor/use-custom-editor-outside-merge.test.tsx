// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('./ExternalFileChangeBanner', () => ({
  keepTabEditsOverExternalChange: vi.fn(),
  ExternalFileChangeBanner: () => <div>banner</div>
}))

import { keepTabEditsOverExternalChange } from './ExternalFileChangeBanner'
import { CustomEditorExternalChangeBanner } from './CustomEditorExternalChangeBanner'
import {
  mergeOutsideChangeIntoEditor,
  setCustomEditorMerging,
  useCustomEditorOutsideMergeStore
} from './use-custom-editor-outside-merge'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const initialState = useAppStore.getState()
const FILE_ID = '/repo/board.sketch'

function seed(externalMutation: 'changed' | null): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the merge reads only the tab's id and externalMutation.
  useAppStore.setState({
    openFiles: [{ id: FILE_ID, externalMutation }]
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
}

afterEach(() => {
  useAppStore.setState(initialState, true)
  useCustomEditorOutsideMergeStore.setState({ merging: {} })
  vi.mocked(keepTabEditsOverExternalChange).mockClear()
})

describe('custom editor outside merge', () => {
  it('hands a disk change to an editor that merges, and keeps the merged edits', async () => {
    seed('changed')
    setCustomEditorMerging(FILE_ID, true)
    const host = { mergeOutsideChange: vi.fn().mockReturnValue(true) }
    await expect(
      mergeOutsideChangeIntoEditor(FILE_ID, host, 'a', async () => 'a+agent')
    ).resolves.toBe(true)
    expect(host.mergeOutsideChange).toHaveBeenCalledWith('a+agent', 'a')
    expect(keepTabEditsOverExternalChange).toHaveBeenCalledOnce()
  })

  it('leaves the banner when the editor cannot merge', async () => {
    seed('changed')
    setCustomEditorMerging(FILE_ID, true)
    const host = { mergeOutsideChange: vi.fn().mockReturnValue(false) }
    await expect(
      mergeOutsideChangeIntoEditor(FILE_ID, host, 'a', async () => 'a+agent')
    ).resolves.toBe(false)
    expect(keepTabEditsOverExternalChange).not.toHaveBeenCalled()
    expect(useCustomEditorOutsideMergeStore.getState().merging[FILE_ID]).toBeUndefined()
  })

  it('shows the banner unless the tab’s editor merges', async () => {
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
    await act(async () => setCustomEditorMerging(FILE_ID, true))
    expect(container.textContent).toBe('')
    await act(async () => root.unmount())
  })
})
