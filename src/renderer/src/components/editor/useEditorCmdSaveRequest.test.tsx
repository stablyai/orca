// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_REQUEST_CMD_SAVE_EVENT } from './editor-autosave'
import { useEditorCmdSaveRequest } from './useEditorCmdSaveRequest'

const storeState = vi.hoisted(() => ({ editorDrafts: {} as Record<string, string> }))
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
})
