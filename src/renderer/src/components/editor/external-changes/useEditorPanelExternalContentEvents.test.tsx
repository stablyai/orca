// @vitest-environment happy-dom

import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from '../autosave/editor-autosave'
import type { DiffContent, FileContent } from '../loading/editor-panel-content-types'
import { useEditorPanelExternalContentEvents } from './useEditorPanelExternalContentEvents'

const markChangedOnDisk = vi.hoisted(() => vi.fn())
vi.mock('./editor-changed-on-disk-mark', () => ({ markFileChangedOnDisk: markChangedOnDisk }))

type ProbeCalls = {
  invalidate: ReturnType<typeof vi.fn>
  invalidateDiff: ReturnType<typeof vi.fn>
  loadDiff: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
}

type ProbeProps = {
  activeFileId: string
  calls: ProbeCalls
  isVisible: boolean
  openFiles: OpenFile[]
  /** Loaded panel content; the probe writes the latest back into `current`. */
  contents?: { current: Record<string, FileContent> }
}

function ExternalContentProbe({
  activeFileId,
  calls,
  isVisible,
  openFiles,
  contents
}: ProbeProps): null {
  const activeContentFileIdRef = useRef(activeFileId)
  const isVisibleRef = useRef(isVisible)
  const openFilesRef = useRef(openFiles)
  const editorViewModeRef = useRef({})
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>(
    () => contents?.current ?? {}
  )
  if (contents) {
    contents.current = fileContents
  }
  const [, setDiffContents] = useState<Record<string, DiffContent>>({})

  useLayoutEffect(() => {
    activeContentFileIdRef.current = activeFileId
    isVisibleRef.current = isVisible
    openFilesRef.current = openFiles
  }, [activeFileId, isVisible, openFiles])

  useEditorPanelExternalContentEvents({
    activeContentFileIdRef,
    editorViewModeRef,
    invalidateContent: calls.invalidate,
    invalidateDiffContent: calls.invalidateDiff,
    isVisibleRef,
    loadDiffContent: calls.loadDiff,
    loadFileContent: calls.loadFile,
    openFilesRef,
    setDiffContents,
    setFileContents
  } as Parameters<typeof useEditorPanelExternalContentEvents>[0])
  return null
}

function makeFile(id: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: `/remote/repo/${id}.ts`,
    relativePath: `${id}.ts`,
    worktreeId: 'ssh-worktree',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function makeCalls(): ProbeCalls {
  return {
    invalidate: vi.fn(),
    invalidateDiff: vi.fn(),
    loadDiff: vi.fn(async () => undefined),
    loadFile: vi.fn(async () => undefined)
  }
}

describe('useEditorPanelExternalContentEvents', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("moves the record's other loaded views to the saved text when the saving tab closed mid-save", () => {
    const other = makeFile('other')
    const preview = makeFile('preview', {
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: 'other'
    })
    const loaded: Record<string, FileContent> = {
      other: { content: 'old disk', isBinary: false },
      preview: { content: 'old disk', isBinary: false },
      unrelated: { content: 'old disk', isBinary: false }
    }
    const contents = { current: loaded }
    act(() => {
      root.render(
        <ExternalContentProbe
          activeFileId={other.id}
          calls={makeCalls()}
          isVisible
          openFiles={[other, preview]}
          contents={contents}
        />
      )
    })
    act(() => {
      window.dispatchEvent(
        new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
          detail: {
            fileId: 'closed-saver',
            content: 'saved',
            recordViewIds: ['closed-saver', 'other']
          }
        })
      )
    })
    expect(contents.current.other?.content).toBe('saved')
    expect(contents.current.preview?.content).toBe('saved')
    expect(contents.current.unrelated?.content).toBe('old disk')
  })
})
