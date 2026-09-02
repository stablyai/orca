// @vitest-environment happy-dom

import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { useEditorPanelExternalContentEvents } from './useEditorPanelExternalContentEvents'

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
}

function ExternalContentProbe({ activeFileId, calls, isVisible, openFiles }: ProbeProps): null {
  const activeContentFileIdRef = useRef(activeFileId)
  const isVisibleRef = useRef(isVisible)
  const openFilesRef = useRef(openFiles)
  const editorViewModeRef = useRef({})
  const [, setFileContents] = useState<Record<string, FileContent>>({})
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

function dispatchExternalChange(relativePath: string): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, {
        detail: {
          worktreeId: 'ssh-worktree',
          worktreePath: '/remote/repo',
          relativePath
        }
      })
    )
  })
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

  it('routes one remote change to one visible owner instead of every retained panel', () => {
    const changedFile = makeFile('changed')
    const otherFiles = Array.from({ length: 9 }, (_, index) => makeFile(`other-${index}`))
    const openFiles = [changedFile, ...otherFiles]
    const ownerCalls = makeCalls()
    const retainedCalls = otherFiles.map(() => makeCalls())

    act(() => {
      root.render(
        <>
          <ExternalContentProbe
            activeFileId={changedFile.id}
            calls={ownerCalls}
            isVisible
            openFiles={openFiles}
          />
          {otherFiles.map((file, index) => (
            <ExternalContentProbe
              key={file.id}
              activeFileId={file.id}
              calls={retainedCalls[index]}
              isVisible={false}
              openFiles={openFiles}
            />
          ))}
        </>
      )
    })
    dispatchExternalChange(changedFile.relativePath)

    expect(ownerCalls.loadFile).toHaveBeenCalledOnce()
    expect(retainedCalls.flatMap((calls) => calls.loadFile.mock.calls)).toHaveLength(0)
    for (const calls of retainedCalls) {
      expect(calls.invalidate).toHaveBeenCalledExactlyOnceWith([changedFile.id])
    }
  })

  it('invalidates a hidden owner without reloading until reveal', () => {
    const changedFile = makeFile('changed')
    const calls = makeCalls()

    act(() => {
      root.render(
        <ExternalContentProbe
          activeFileId={changedFile.id}
          calls={calls}
          isVisible={false}
          openFiles={[changedFile]}
        />
      )
    })
    dispatchExternalChange(changedFile.relativePath)

    expect(calls.loadFile).not.toHaveBeenCalled()
    expect(calls.invalidate).toHaveBeenCalledExactlyOnceWith([changedFile.id])
  })

  it('keeps dirty hidden content intact', () => {
    const changedFile = makeFile('changed', { isDirty: true })
    const calls = makeCalls()

    act(() => {
      root.render(
        <ExternalContentProbe
          activeFileId={changedFile.id}
          calls={calls}
          isVisible={false}
          openFiles={[changedFile]}
        />
      )
    })
    dispatchExternalChange(changedFile.relativePath)

    expect(calls.loadFile).not.toHaveBeenCalled()
    expect(calls.invalidate).not.toHaveBeenCalled()
  })

  it('invalidates an inactive cached Changes diff after reloading its visible file', () => {
    const changedFile = makeFile('changed')
    const calls = makeCalls()

    act(() => {
      root.render(
        <ExternalContentProbe
          activeFileId={changedFile.id}
          calls={calls}
          isVisible
          openFiles={[changedFile]}
        />
      )
    })
    dispatchExternalChange(changedFile.relativePath)

    expect(calls.loadFile).toHaveBeenCalledOnce()
    expect(calls.loadDiff).not.toHaveBeenCalled()
    expect(calls.invalidateDiff).toHaveBeenCalledExactlyOnceWith([changedFile.id])
  })

  it('uses one event generation for visible source and preview reloads', () => {
    const source = makeFile('source', {
      filePath: '/remote/repo/shared.md',
      relativePath: 'shared.md'
    })
    const preview = makeFile('preview', {
      filePath: '/remote/repo/shared.md',
      relativePath: 'shared.md',
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: source.id
    })
    const sourceCalls = makeCalls()
    const previewCalls = makeCalls()

    act(() => {
      root.render(
        <>
          <ExternalContentProbe
            activeFileId={source.id}
            calls={sourceCalls}
            isVisible
            openFiles={[source, preview]}
          />
          <ExternalContentProbe
            activeFileId={preview.id}
            calls={previewCalls}
            isVisible
            openFiles={[source, preview]}
          />
        </>
      )
    })
    dispatchExternalChange(source.relativePath)

    const sourceOptions = sourceCalls.loadFile.mock.calls[0]?.[4]
    const previewOptions = previewCalls.loadFile.mock.calls[0]?.[4]
    expect(sourceOptions?.externalEventGeneration).toBeTypeOf('number')
    expect(previewOptions?.externalEventGeneration).toBe(sourceOptions?.externalEventGeneration)
  })
})
