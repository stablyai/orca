// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR,
  type FileContent
} from './editor-panel-content-types'
import {
  OWNER_NOT_READY_RETRY_LIMIT,
  shouldRetryFileLoadError,
  useEditorPanelFileLoadRetry
} from './useEditorPanelFileLoadRetry'

// Why: the real setFileContents replaces the map; a key the hook deletes must
// disappear. A merge (Object.assign) would silently keep a stale loadError.
function replaceFileContents(
  target: Record<string, FileContent>,
  next: Record<string, FileContent>
): void {
  for (const key of Object.keys(target)) {
    delete target[key]
  }
  Object.assign(target, next)
}

function makeFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'tab-1',
    filePath: '/home/user/project/src/index.ts',
    relativePath: 'src/index.ts',
    worktreeId: 'repo-ssh::/home/user/project',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

// Drives the real hook with a controllable fileContents store, mirroring how
// useEditorPanelContentState wires it up.
function Harness({
  file,
  fileContents,
  attemptsRef,
  loadFileContent,
  setFileContents
}: {
  file: OpenFile
  fileContents: Record<string, FileContent>
  attemptsRef: { current: Record<string, number> }
  loadFileContent: (filePath: string, id: string) => Promise<void>
  setFileContents: (
    updater: (prev: Record<string, FileContent>) => Record<string, FileContent>
  ) => void
}): null {
  useEditorPanelFileLoadRetry({
    activeFile: file,
    fileContents,
    fileLoadRetryAttemptsRef: attemptsRef,
    loadFileContent: loadFileContent as never,
    openFilesRef: { current: [file] },
    setFileContents: setFileContents as never
  })
  return null
}

describe('useEditorPanelFileLoadRetry — owner-not-ready bounding (#6648)', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let setTimeoutSpy: MockInstance

  beforeEach(() => {
    vi.useFakeTimers()
    // Run scheduled retries immediately so we can exhaust the budget without
    // waiting ~2 minutes of real time.
    setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof window.setTimeout)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    container = null
    root = null
    setTimeoutSpy.mockRestore()
    vi.useRealTimers()
  })

  it('classifies retryable vs terminal errors', () => {
    expect(shouldRetryFileLoadError(WORKTREE_OWNER_NOT_READY_ERROR)).toBe(true)
    expect(shouldRetryFileLoadError(WORKTREE_OWNER_UNREACHABLE_ERROR)).toBe(false)
    expect(shouldRetryFileLoadError('Access denied: outside allowed directories')).toBe(false)
  })

  it('stops after the budget and shows a truthful terminal message, then Retry re-arms', () => {
    const file = makeFile()
    const attemptsRef = { current: {} as Record<string, number> }
    // The owner never hydrates: every retry re-fails with owner-not-ready.
    const fileContents: Record<string, FileContent> = {
      [file.id]: { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    }
    const setFileContents = (
      updater: (prev: Record<string, FileContent>) => Record<string, FileContent>
    ): void => {
      replaceFileContents(fileContents, updater(fileContents))
    }
    // loadFileContent (the retry callback) clears then re-fails as owner-not-ready.
    const loadFileContent = vi.fn(async (_filePath: string, id: string) => {
      fileContents[id] = { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // Re-render the hook repeatedly; each render that still sees the
    // owner-not-ready error schedules (and our spy immediately runs) one retry.
    for (let i = 0; i < OWNER_NOT_READY_RETRY_LIMIT + 2; i++) {
      act(() => {
        root?.render(
          <Harness
            file={file}
            fileContents={{ ...fileContents }}
            attemptsRef={attemptsRef}
            loadFileContent={loadFileContent}
            setFileContents={setFileContents}
          />
        )
      })
      if (fileContents[file.id]?.loadError === WORKTREE_OWNER_UNREACHABLE_ERROR) {
        break
      }
    }

    // Budget honored: retried at most the limit, then went terminal.
    expect(loadFileContent.mock.calls.length).toBeLessThanOrEqual(OWNER_NOT_READY_RETRY_LIMIT)
    expect(fileContents[file.id]?.loadError).toBe(WORKTREE_OWNER_UNREACHABLE_ERROR)

    // The terminal error is not auto-retried.
    const callsAfterTerminal = loadFileContent.mock.calls.length
    act(() => {
      root?.render(
        <Harness
          file={file}
          fileContents={{ ...fileContents }}
          attemptsRef={attemptsRef}
          loadFileContent={loadFileContent}
          setFileContents={setFileContents}
        />
      )
    })
    expect(loadFileContent.mock.calls.length).toBe(callsAfterTerminal)

    // Retry (reloadFileContent) clears the attempt budget for a fresh start.
    delete attemptsRef.current[file.id]
    expect(attemptsRef.current[file.id]).toBeUndefined()
  })

  it('stops immediately once the read succeeds (no terminal message)', () => {
    const file = makeFile()
    const attemptsRef = { current: {} as Record<string, number> }
    const fileContents: Record<string, FileContent> = {
      [file.id]: { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    }
    const setFileContents = (
      updater: (prev: Record<string, FileContent>) => Record<string, FileContent>
    ): void => {
      replaceFileContents(fileContents, updater(fileContents))
    }
    // The repo hydrates on the first retry: the read now succeeds.
    const loadFileContent = vi.fn(async (_filePath: string, id: string) => {
      fileContents[id] = { content: 'remote', isBinary: false }
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <Harness
          file={file}
          fileContents={{ ...fileContents }}
          attemptsRef={attemptsRef}
          loadFileContent={loadFileContent}
          setFileContents={setFileContents}
        />
      )
    })

    expect(loadFileContent).toHaveBeenCalledTimes(1)
    expect(fileContents[file.id]?.loadError).toBeUndefined()
    expect(fileContents[file.id]?.content).toBe('remote')
  })
})
