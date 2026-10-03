import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
const { getState, attemptEditorFileSave } = vi.hoisted(() => ({
  getState: vi.fn(),
  attemptEditorFileSave: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('./editor-file-save-attempt', () => ({ attemptEditorFileSave }))

import { MissingEditorFileBanner, restoreMissingEditorFile } from './MissingEditorFileBanner'

const file = {
  id: 'file-1',
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: true,
  externalMutation: 'deleted',
  mode: 'edit'
} satisfies OpenFile

describe('MissingEditorFileBanner', () => {
  it('explains that edits are preserved and offers an explicit restore action', () => {
    const html = renderToStaticMarkup(<MissingEditorFileBanner file={file} />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('will not be saved automatically')
    expect(html).toContain('Restore File')
  })

  it('keeps the cleared mutation after a successful restore', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation']) => {
        if (externalMutation === null) {
          const { externalMutation: _, ...fileWithoutMutation } = liveFile
          liveFile = fileWithoutMutation
          return
        }
        liveFile = { ...liveFile, externalMutation }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockResolvedValue(true)

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).toHaveBeenCalledTimes(1)
    expect(liveFile.externalMutation).toBeUndefined()
  })

  it('restores the missing-file mark when saving fails without a newer update', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation']) => {
        if (externalMutation === null) {
          const { externalMutation: _, ...fileWithoutMutation } = liveFile
          liveFile = fileWithoutMutation
          return
        }
        liveFile = { ...liveFile, externalMutation }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockResolvedValue(false)

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).toHaveBeenNthCalledWith(1, 'file-1', null)
    expect(setExternalMutation).toHaveBeenNthCalledWith(2, 'file-1', 'deleted')
    expect(liveFile.externalMutation).toBe('deleted')
  })

  it('keeps a newer external mutation when restoration fails', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation']) => {
        liveFile = { ...liveFile, externalMutation }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockImplementation(async () => {
      liveFile = { ...liveFile, externalMutation: 'changed' }
      return false
    })

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).toHaveBeenCalledTimes(1)
    expect(setExternalMutation).toHaveBeenCalledWith('file-1', null)
    expect(liveFile.externalMutation).toBe('changed')
  })
})
