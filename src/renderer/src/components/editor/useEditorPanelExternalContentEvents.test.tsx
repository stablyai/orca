// @vitest-environment happy-dom

import { act, useLayoutEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'
import type { DiffContent, FileContent } from './editor-panel-content-types'
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

  it('keeps one slow watcher read in flight and follows up once with the latest change', async () => {
    const changedFile = makeFile('changed')
    const calls = makeCalls()
    const settles: (() => void)[] = []
    calls.loadFile.mockImplementation(() => new Promise<void>((resolve) => settles.push(resolve)))
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
    // Watch batches outpace a slow SSH read: restarting each time would discard every result.
    for (let i = 0; i < 5; i++) {
      dispatchExternalChange(changedFile.relativePath)
    }
    expect(calls.loadFile).toHaveBeenCalledTimes(1)
    await act(async () => settles[0]())
    expect(calls.loadFile).toHaveBeenCalledTimes(2)
    const firstGeneration = calls.loadFile.mock.calls[0][4].externalEventGeneration
    expect(calls.loadFile.mock.calls[1][4].externalEventGeneration).toBe(firstGeneration + 4)
    await act(async () => settles[1]())
    expect(calls.loadFile).toHaveBeenCalledTimes(2)
  })

  it('coalesces slow watcher diff reloads separately from content reads', async () => {
    const diffTab = makeFile('diff', { mode: 'diff', diffSource: 'unstaged' })
    const calls = makeCalls()
    const settles: (() => void)[] = []
    calls.loadDiff.mockImplementation(() => new Promise<void>((resolve) => settles.push(resolve)))
    act(() => {
      root.render(
        <ExternalContentProbe
          activeFileId={diffTab.id}
          calls={calls}
          isVisible
          openFiles={[diffTab]}
        />
      )
    })
    for (let i = 0; i < 3; i++) {
      dispatchExternalChange(diffTab.relativePath)
    }
    expect(calls.loadDiff).toHaveBeenCalledTimes(1)
    await act(async () => settles[0]())
    expect(calls.loadDiff).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['became dirty', (file: OpenFile) => [{ ...file, isDirty: true }]],
    ['was closed', () => []]
  ])('skips the follow-up read when the tab %s meanwhile', async (label, nextFiles) => {
    const changedFile = makeFile('changed')
    const calls = makeCalls()
    const settles: (() => void)[] = []
    calls.loadFile.mockImplementation(() => new Promise<void>((resolve) => settles.push(resolve)))
    const renderProbe = (openFiles: OpenFile[]): void => {
      act(() => {
        root.render(
          <ExternalContentProbe
            activeFileId={changedFile.id}
            calls={calls}
            isVisible
            openFiles={openFiles}
          />
        )
      })
    }
    renderProbe([changedFile])
    dispatchExternalChange(changedFile.relativePath)
    dispatchExternalChange(changedFile.relativePath)
    markChangedOnDisk.mockClear()
    renderProbe(nextFiles(changedFile))
    await act(async () => settles[0]())
    expect(calls.loadFile).toHaveBeenCalledTimes(1)
    if (label === 'became dirty') {
      // The draft stays, but the queued disk change is recorded and the cache marked stale.
      expect(markChangedOnDisk).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ id: changedFile.id, isDirty: true }),
        expect.objectContaining({ origin: 'live' })
      )
      expect(calls.invalidate).toHaveBeenCalledWith([changedFile.id])
    } else {
      expect(markChangedOnDisk).not.toHaveBeenCalled()
    }
  })

  it.each([
    ['content', 'edit', 'loadFile', 'invalidate'],
    ['diff', 'diff', 'loadDiff', 'invalidateDiff']
  ] as const)(
    'invalidates %s when the tab is switched away while a follow-up is queued',
    async (_label, mode, loader, invalidator) => {
      const changedFile = makeFile(
        'changed',
        mode === 'diff' ? { mode, diffSource: 'unstaged' } : {}
      )
      const otherFile = makeFile('other')
      const calls = makeCalls()
      const settles: (() => void)[] = []
      calls[loader].mockImplementation(() => new Promise<void>((resolve) => settles.push(resolve)))
      const renderProbe = (activeFileId: string): void => {
        act(() => {
          root.render(
            <ExternalContentProbe
              activeFileId={activeFileId}
              calls={calls}
              isVisible
              openFiles={[changedFile, otherFile]}
            />
          )
        })
      }
      renderProbe(changedFile.id)
      dispatchExternalChange(changedFile.relativePath)
      dispatchExternalChange(changedFile.relativePath)
      renderProbe(otherFile.id)
      await act(async () => settles[0]())
      // The queued change must not be lost: the reveal path reloads stale content.
      expect(calls[loader]).toHaveBeenCalledTimes(1)
      expect(calls[invalidator]).toHaveBeenCalledWith([changedFile.id])
    }
  )
})
