// @vitest-environment happy-dom

import { act, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR,
  type FileContent
} from './editor-panel-content-types'

const mocks = vi.hoisted(() => {
  const hostConnection: WorktreeHostConnection = {
    phase: 'connecting',
    targetId: 'ssh-a',
    connectionGeneration: null
  }
  return { hostConnection, readRuntimeFileContent: vi.fn() }
})

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  selectWorktreeHostConnectionPhase: () => mocks.hostConnection,
  useWorktreeHostConnection: () => mocks.hostConnection
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: () => 'ssh-a',
  isWorktreeConnectionResolved: () => true
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: (_settings: unknown, connectionId: string | undefined) =>
    connectionId ?? 'local',
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

import {
  OWNER_NOT_READY_RETRY_DELAY_MS,
  useEditorPanelFileLoadRetry
} from './useEditorPanelFileLoadRetry'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const SSH_PROVIDER_UNAVAILABLE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

function setHost(
  phase: WorktreeHostConnection['phase'],
  connectionGeneration: number | null = null
): void {
  mocks.hostConnection = { phase, targetId: 'ssh-a', connectionGeneration }
}

const file: OpenFile = {
  id: 'tab-1',
  filePath: '/home/user/project/src/index.ts',
  relativePath: 'src/index.ts',
  worktreeId: 'repo-ssh::/home/user/project',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}
const OPEN_FILES_REF = { current: [file] }

function RetryHarness({
  fileContents,
  attemptsRef,
  loadFileContent,
  setFileContents
}: {
  fileContents: Record<string, FileContent>
  attemptsRef: { current: Record<string, number> }
  loadFileContent: () => Promise<void>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}): null {
  useEditorPanelFileLoadRetry({
    activeFile: file,
    fileContents,
    fileLoadRetryAttemptsRef: attemptsRef,
    loadFileContent,
    openFilesRef: OPEN_FILES_REF,
    setFileContents
  })
  return null
}

describe('editor file loads while the SSH host connects', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.readRuntimeFileContent.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('shows the connecting copy, not "connection dropped", for a read that failed mid-connect', async () => {
    setHost('connecting')
    mocks.readRuntimeFileContent.mockRejectedValue(new Error(SSH_PROVIDER_UNAVAILABLE))
    let fileContents: Record<string, FileContent> = {}
    let load: EditorPanelFileContentLoader | null = null
    function LoaderHarness(): null {
      load = useEditorPanelFileContentLoader({
        fileLoadRetryAttemptsRef: { current: {} },
        fileReadGenerationCounterRef: { current: 0 },
        fileReadGenerationRef: { current: {} },
        openFilesRef: OPEN_FILES_REF,
        outstandingFileReadsRef: { current: {} },
        setFileContents: (updater) => {
          fileContents = typeof updater === 'function' ? updater(fileContents) : updater
        }
      })
      return null
    }
    act(() => root.render(<LoaderHarness />))
    await act(async () => load?.(file.filePath, file.id, file.worktreeId, file.relativePath))
    expect(fileContents[file.id]?.loadError).toBe(WORKTREE_OWNER_NOT_READY_ERROR)

    setHost('unavailable')
    await act(async () => load?.(file.filePath, file.id, file.worktreeId, file.relativePath))
    expect(fileContents[file.id]?.loadError).toBe(SSH_PROVIDER_UNAVAILABLE)
  })

  it('spends no retry budget while connecting, then reloads exactly once when the host connects', () => {
    setHost('connecting')
    const attemptsRef: { current: Record<string, number> } = { current: {} }
    let fileContents: Record<string, FileContent> = {
      [file.id]: { content: '', isBinary: false, loadError: WORKTREE_OWNER_NOT_READY_ERROR }
    }
    const setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>> = (updater) => {
      fileContents = typeof updater === 'function' ? updater(fileContents) : updater
    }
    const loadFileContent = vi.fn(async () => undefined)
    const render = (): void =>
      act(() =>
        root.render(
          <RetryHarness
            fileContents={fileContents}
            attemptsRef={attemptsRef}
            loadFileContent={loadFileContent}
            setFileContents={setFileContents}
          />
        )
      )

    render()
    act(() => vi.advanceTimersByTime(OWNER_NOT_READY_RETRY_DELAY_MS * 10))
    expect(loadFileContent).not.toHaveBeenCalled()
    expect(attemptsRef.current[file.id]).toBeUndefined()

    setHost('connected', 1)
    render()
    expect(loadFileContent).toHaveBeenCalledOnce()
    expect(attemptsRef.current[file.id]).toBe(0)
    expect(fileContents[file.id]).toBeUndefined()

    render()
    act(() => vi.advanceTimersByTime(OWNER_NOT_READY_RETRY_DELAY_MS * 10))
    expect(loadFileContent).toHaveBeenCalledOnce()
  })

  it('re-arms an exhausted budget when the host reconnects under a new generation', () => {
    setHost('connected', 1)
    const attemptsRef: { current: Record<string, number> } = { current: { [file.id]: 3 } }
    let fileContents: Record<string, FileContent> = {
      [file.id]: { content: '', isBinary: false, loadError: WORKTREE_OWNER_UNREACHABLE_ERROR }
    }
    const setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>> = (updater) => {
      fileContents = typeof updater === 'function' ? updater(fileContents) : updater
    }
    const loadFileContent = vi.fn(async () => undefined)
    const render = (): void =>
      act(() =>
        root.render(
          <RetryHarness
            fileContents={fileContents}
            attemptsRef={attemptsRef}
            loadFileContent={loadFileContent}
            setFileContents={setFileContents}
          />
        )
      )

    render()
    expect(loadFileContent).not.toHaveBeenCalled()

    setHost('connected', 2)
    render()
    expect(loadFileContent).toHaveBeenCalledOnce()
    expect(attemptsRef.current[file.id]).toBe(0)
  })
})
