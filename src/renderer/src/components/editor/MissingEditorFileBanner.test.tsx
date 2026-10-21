import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  beforeEach(() => {
    vi.clearAllMocks()
  })
  it('explains that edits are preserved and offers an explicit restore action', () => {
    const html = renderToStaticMarkup(<MissingEditorFileBanner file={file} />)

    expect(html).toContain('role="alert"')
    expect(html).toContain('will not be saved automatically')
    expect(html).toContain('Restore File')
  })

  it('keeps the cleared mutation after a successful restore', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation'] | null) => {
        if (externalMutation === null) {
          const { externalMutation: _, ...fileWithoutMutation } = liveFile
          liveFile = fileWithoutMutation
          return
        }
        liveFile = { ...liveFile, externalMutation: externalMutation ?? undefined }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockImplementation(async () => {
      setExternalMutation(file.id, null)
      return true
    })

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).toHaveBeenCalledTimes(1)
    expect(liveFile.externalMutation).toBeUndefined()
  })

  it('restores the missing-file mark when saving fails without a newer update', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation'] | null) => {
        if (externalMutation === null) {
          const { externalMutation: _, ...fileWithoutMutation } = liveFile
          liveFile = fileWithoutMutation
          return
        }
        liveFile = { ...liveFile, externalMutation: externalMutation ?? undefined }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockResolvedValue(false)

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).not.toHaveBeenCalled()
    expect(liveFile.externalMutation).toBe('deleted')
  })

  it('keeps a newer external mutation when restoration fails', async () => {
    let liveFile: OpenFile = file
    const setExternalMutation = vi.fn(
      (_: string, externalMutation: OpenFile['externalMutation'] | null) => {
        liveFile = { ...liveFile, externalMutation: externalMutation ?? undefined }
      }
    )
    getState.mockImplementation(() => ({ openFiles: [liveFile], setExternalMutation }))
    attemptEditorFileSave.mockImplementation(async () => {
      liveFile = { ...liveFile, externalMutation: 'changed' }
      return false
    })

    await restoreMissingEditorFile(file)

    expect(setExternalMutation).not.toHaveBeenCalled()
    expect(liveFile.externalMutation).toBe('changed')
  })
})
