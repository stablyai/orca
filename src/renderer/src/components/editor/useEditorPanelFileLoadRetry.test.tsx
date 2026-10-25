// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE,
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR,
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR,
  type FileContent
} from './editor-panel-content-types'
import {
  FILE_LOAD_RETRY_DELAYS_MS,
  isHostSelectorNotFoundError,
  OWNER_NOT_READY_RETRY_DELAY_MS,
  OWNER_NOT_READY_RETRY_LIMIT,
  shouldRetryFileLoadError,
  useEditorPanelFileLoadRetry
} from './useEditorPanelFileLoadRetry'

// Replace maps like the real setter; merging would retain deleted loadError entries and hide bugs.
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

function Harness({
  file,
  fileContents,
  attemptsRef,
  isVisible = true,
  loadFileContent,
  setFileContents
}: {
  file: OpenFile
  fileContents: Record<string, FileContent>
  attemptsRef: { current: Record<string, number> }
  isVisible?: boolean
  loadFileContent: (filePath: string, id: string) => Promise<void>
  setFileContents: (
    updater: (prev: Record<string, FileContent>) => Record<string, FileContent>
  ) => void
}): null {
  useEditorPanelFileLoadRetry({
    activeFile: isVisible ? file : null,
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
    // Run retries immediately to exercise the two-minute budget without real-time waits.
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

  it('does not spend retry budget when hiding cancels a pending retry', () => {
    setTimeoutSpy.mockRestore()
    setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const file = makeFile()
    const attemptsRef = { current: {} as Record<string, number> }
    const fileContents: Record<string, FileContent> = {
      [file.id]: { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    }
    const loadFileContent = vi.fn(async () => undefined)
    const setFileContents = vi.fn((updater) => updater(fileContents))

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <Harness
          file={file}
          fileContents={fileContents}
          attemptsRef={attemptsRef}
          loadFileContent={loadFileContent}
          setFileContents={setFileContents as never}
        />
      )
    })
    expect(loadFileContent).not.toHaveBeenCalled()
    expect(attemptsRef.current[file.id]).toBeUndefined()

    act(() => {
      root?.render(
        <Harness
          file={file}
          fileContents={fileContents}
          attemptsRef={attemptsRef}
          isVisible={false}
          loadFileContent={loadFileContent}
          setFileContents={setFileContents as never}
        />
      )
    })
    act(() => vi.advanceTimersByTime(OWNER_NOT_READY_RETRY_DELAY_MS))
    expect(loadFileContent).not.toHaveBeenCalled()
    expect(attemptsRef.current[file.id]).toBeUndefined()

    act(() => {
      root?.render(
        <Harness
          file={file}
          fileContents={fileContents}
          attemptsRef={attemptsRef}
          loadFileContent={loadFileContent}
          setFileContents={setFileContents as never}
        />
      )
    })
    act(() => vi.advanceTimersByTime(OWNER_NOT_READY_RETRY_DELAY_MS))
    expect(loadFileContent).toHaveBeenCalledOnce()
    expect(attemptsRef.current[file.id]).toBe(1)
  })

  it('stops after the budget and shows a truthful terminal message', () => {
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
    const loadFileContent = vi.fn(async (_filePath: string, id: string) => {
      fileContents[id] = { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    // Each render with a transient error schedules one retry, which the timer spy runs immediately.
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

describe('useEditorPanelFileLoadRetry — selector_not_found bounding (#21041)', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let setTimeoutSpy: MockInstance

  beforeEach(() => {
    vi.useFakeTimers()
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

  it('retries the raw resolver code but never the terminal sentinel', () => {
    expect(shouldRetryFileLoadError(WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE)).toBe(true)
    expect(shouldRetryFileLoadError('Selector not found')).toBe(true)
    expect(
      shouldRetryFileLoadError(WORKTREE_HOST_UNRESOLVED_ERROR, WORKTREE_HOST_UNRESOLVED_CODE)
    ).toBe(false)
    // Why: the sentinel is the code, so a localized or reworded message stays terminal.
    expect(shouldRetryFileLoadError('texto localizado', WORKTREE_HOST_UNRESOLVED_CODE)).toBe(false)
  })

  it('matches only the exact selector_not_found token', () => {
    expect(isHostSelectorNotFoundError({ loadError: 'selector_not_found' })).toBe(true)
    expect(
      isHostSelectorNotFoundError({
        loadError: 'Selector not found',
        loadErrorCode: 'selector_not_found'
      })
    ).toBe(true)
    // Transport-wrapped token after a message boundary (shared matcher contract).
    expect(
      isHostSelectorNotFoundError({ loadError: 'relay call failed: selector_not_found\n' })
    ).toBe(true)
    expect(isHostSelectorNotFoundError({ loadError: 'Selector_Not_Found' })).toBe(false)
    expect(isHostSelectorNotFoundError({ loadError: 'SELECTOR_NOT_FOUND' })).toBe(false)
    expect(isHostSelectorNotFoundError({ loadError: 'selector_not_found_v2' })).toBe(false)
    expect(isHostSelectorNotFoundError({ loadError: 'the selector_not_found branch ran' })).toBe(
      false
    )
    expect(
      isHostSelectorNotFoundError({
        loadError: 'Selector not found',
        loadErrorCode: 'Selector_Not_Found'
      })
    ).toBe(false)
    expect(
      isHostSelectorNotFoundError({
        loadError: 'Selector not found',
        loadErrorCode: 'tab_not_found'
      })
    ).toBe(false)
  })

  // Exercise machine codes on message and code fields; prose-only matching would leave the latter retrying forever.
  it.each([
    ['bare code as message', { loadError: WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE }],
    [
      'code with human-readable message',
      { loadError: 'Selector not found', loadErrorCode: WORKTREE_HOST_SELECTOR_NOT_FOUND_CODE }
    ]
  ])(
    'keeps a dirty mirrored tab (%s): bounded retries end in a truthful terminal message, not a close',
    (_hostAnswer, failure) => {
      const file = makeFile({
        id: 'mirror-1',
        filePath: '/home/user/project/NOTES.md',
        relativePath: 'NOTES.md',
        language: 'markdown',
        mode: 'markdown-preview',
        isDirty: true,
        mirroredFromRuntimeSession: true
      })
      const attemptsRef = { current: {} as Record<string, number> }
      const failedRead = (): FileContent => ({ content: '', isBinary: false, ...failure })
      const fileContents: Record<string, FileContent> = { [file.id]: failedRead() }
      const setFileContents = (
        updater: (prev: Record<string, FileContent>) => Record<string, FileContent>
      ): void => {
        replaceFileContents(fileContents, updater(fileContents))
      }
      // The host's resolver never places the workspace: every retry re-fails the same way.
      const loadFileContent = vi.fn(async (_filePath: string, id: string) => {
        fileContents[id] = failedRead()
      })

      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)

      for (let i = 0; i < FILE_LOAD_RETRY_DELAYS_MS.length + 2; i++) {
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
        if (fileContents[file.id]?.loadError === WORKTREE_HOST_UNRESOLVED_ERROR) {
          break
        }
      }

      // Exhaustion must preserve the tab while replacing transient raw codes with terminal retry guidance.
      expect(loadFileContent).toHaveBeenCalledTimes(FILE_LOAD_RETRY_DELAYS_MS.length)
      expect(fileContents[file.id]?.loadError).toBe(WORKTREE_HOST_UNRESOLVED_ERROR)
      expect(fileContents[file.id]?.loadErrorCode).toBe(WORKTREE_HOST_UNRESOLVED_CODE)

      // Terminal: the message is not auto-retried.
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
      expect(loadFileContent).toHaveBeenCalledTimes(FILE_LOAD_RETRY_DELAYS_MS.length)
    }
  )
})
