// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT } from './editor-autosave'
import { useEditorCmdSaveRequest } from './useEditorCmdSaveRequest'

const storeState = vi.hoisted(() => {
  const editorDrafts: Record<string, string> = {}
  return {
    editorDrafts,
    editorViewMode: {},
    markdownViewMode: {},
    settings: { editorInsertFinalNewline: false }
  }
})
const EMPTY_FILE_CONTENTS: Parameters<typeof useEditorCmdSaveRequest>[0]['fileContents'] = {}

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

type ProbeProps = {
  activeFile: OpenFile
  enabled: boolean
  fileContents?: Parameters<typeof useEditorCmdSaveRequest>[0]['fileContents']
  onSave: (content: string) => Promise<boolean>
  openFiles?: OpenFile[]
}

function SaveProbe({
  activeFile,
  enabled,
  fileContents = EMPTY_FILE_CONTENTS,
  onSave,
  openFiles
}: ProbeProps): null {
  useEditorCmdSaveRequest({
    activeFile,
    openFiles: openFiles ?? [activeFile],
    fileContents,
    handleSave: onSave,
    enabled
  })
  return null
}

function makeFile(id: string): OpenFile {
  return {
    id,
    filePath: `/repo/${id}.md`,
    relativePath: `${id}.md`,
    worktreeId: `worktree-${id}`,
    language: 'markdown',
    isDirty: true,
    mode: 'edit'
  }
}

describe('useEditorCmdSaveRequest', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    storeState.editorDrafts = {}
    storeState.markdownViewMode = {}
    storeState.settings.editorInsertFinalNewline = false
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('saves only the visible panel that owns the requested file', () => {
    const visibleFile = makeFile('visible')
    const otherVisibleFile = makeFile('other-visible')
    const hiddenFile = makeFile('hidden')
    const visibleSave = vi.fn(async () => true)
    const mirroredSave = vi.fn(async () => true)
    const otherVisibleSave = vi.fn(async () => true)
    const hiddenSave = vi.fn(async () => true)
    storeState.editorDrafts = {
      [visibleFile.id]: 'visible draft',
      [otherVisibleFile.id]: 'other draft',
      [hiddenFile.id]: 'hidden draft'
    }

    act(() => {
      root.render(
        <>
          <SaveProbe activeFile={visibleFile} enabled onSave={visibleSave} />
          <SaveProbe activeFile={visibleFile} enabled={false} onSave={mirroredSave} />
          <SaveProbe activeFile={otherVisibleFile} enabled onSave={otherVisibleSave} />
          <SaveProbe activeFile={hiddenFile} enabled={false} onSave={hiddenSave} />
        </>
      )
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
          detail: { fileId: visibleFile.id }
        })
      )
    })

    expect(visibleSave).toHaveBeenCalledExactlyOnceWith('visible draft')
    expect(mirroredSave).not.toHaveBeenCalled()
    expect(otherVisibleSave).not.toHaveBeenCalled()
    expect(hiddenSave).not.toHaveBeenCalled()
  })

  it('uses the preview tab for ownership and the source file for content', () => {
    const sourceFile = makeFile('source')
    const previewFile: OpenFile = {
      ...sourceFile,
      id: 'markdown-preview::source',
      markdownPreviewSourceFileId: sourceFile.id,
      mode: 'markdown-preview'
    }
    const save = vi.fn(async () => true)
    storeState.editorDrafts = { [sourceFile.id]: 'source draft' }

    act(() => {
      root.render(
        <SaveProbe
          activeFile={previewFile}
          enabled
          onSave={save}
          openFiles={[sourceFile, previewFile]}
        />
      )
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
          detail: { fileId: sourceFile.id }
        })
      )
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, {
          detail: { fileId: previewFile.id }
        })
      )
    })

    expect(save).toHaveBeenCalledExactlyOnceWith('source draft')
  })

  it('saves the loaded content of a clean code file when final-newline insertion is enabled', () => {
    const file: OpenFile = {
      ...makeFile('clean'),
      filePath: '/repo/clean.ts',
      relativePath: 'clean.ts',
      language: 'typescript',
      isDirty: false
    }
    const save = vi.fn(async () => true)
    storeState.settings.editorInsertFinalNewline = true
    act(() => {
      root.render(
        <SaveProbe
          activeFile={file}
          enabled
          onSave={save}
          fileContents={{ clean: { content: 'const x = 1', isBinary: false } }}
        />
      )
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, { detail: { fileId: file.id } })
      )
    })

    expect(save).toHaveBeenCalledExactlyOnceWith('const x = 1')
  })

  it('does not save a clean code file without loaded text', () => {
    const file: OpenFile = {
      ...makeFile('clean'),
      filePath: '/repo/clean.ts',
      relativePath: 'clean.ts',
      language: 'typescript',
      isDirty: false
    }
    const save = vi.fn(async () => true)
    storeState.settings.editorInsertFinalNewline = true
    act(() => {
      root.render(<SaveProbe activeFile={file} enabled onSave={save} />)
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, { detail: { fileId: file.id } })
      )
    })

    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    { csvPreviewOnly: true, shouldSave: false },
    { csvPreviewOnly: false, shouldSave: true }
  ])(
    'handles a clean CSV source view (preview only: $csvPreviewOnly)',
    ({ csvPreviewOnly, shouldSave }) => {
      const file: OpenFile = {
        ...makeFile('csv-preview'),
        filePath: '/repo/large.csv',
        relativePath: 'large.csv',
        language: 'csv',
        isDirty: false,
        csvPreviewOnly
      }
      const save = vi.fn(async () => true)
      storeState.settings.editorInsertFinalNewline = true
      storeState.markdownViewMode = { [file.id]: 'source' }
      act(() => {
        root.render(
          <SaveProbe
            activeFile={file}
            enabled
            onSave={save}
            fileContents={{ [file.id]: { content: 'name\npartial', isBinary: false } }}
          />
        )
      })
      act(() => {
        window.dispatchEvent(
          new CustomEvent(ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT, { detail: { fileId: file.id } })
        )
      })

      if (shouldSave) {
        expect(save).toHaveBeenCalledExactlyOnceWith('name\npartial')
      } else {
        expect(save).not.toHaveBeenCalled()
      }
    }
  )
})
