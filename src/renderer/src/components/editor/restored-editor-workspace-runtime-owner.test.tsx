// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import type { FileContent } from './editor-panel-content-types'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const WORKTREE = 'repo-1::/root/repo'
const FILE_PATH = '/root/repo/README.md'

/** The workspace now lives on its managed server; the tab was saved by the relay era, unstamped. */
function seedConvertedWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WORKTREE,
    repos: [
      {
        id: 'repo-1',
        path: '/root/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: WORKTREE,
          repoId: 'repo-1',
          path: '/root/repo',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    }
  })
}

function openRestored(filePath: string): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/root/repo/'.length),
      worktreeId: WORKTREE,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

describe('a restored tab whose workspace moved to its managed server', () => {
  let container: HTMLDivElement
  let root: Root
  let load: EditorPanelFileContentLoader | null
  let fileContents: Record<string, FileContent>

  beforeEach(() => {
    mocks.readRuntimeFileContent.mockReset()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# repo', isBinary: false })
    fileContents = {}
    load = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    function LoaderHarness(): null {
      load = useEditorPanelFileContentLoader({
        fileLoadRetryAttemptsRef: { current: {} },
        fileReadGenerationCounterRef: { current: 0 },
        fileReadGenerationRef: { current: {} },
        openFilesRef: {
          get current() {
            return useAppStore.getState().openFiles
          }
        },
        outstandingFileReadsRef: { current: {} },
        setFileContents: (updater) => {
          fileContents = typeof updater === 'function' ? updater(fileContents) : updater
        }
      })
      return null
    }
    act(() => root.render(<LoaderHarness />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('takes the server as its owner in place, then reads the file there', async () => {
    seedConvertedWorkspace()
    const restoredId = openRestored(FILE_PATH)
    await act(async () => load!(FILE_PATH, restoredId, WORKTREE, 'README.md'))

    const state = useAppStore.getState()
    expect(state.openFiles).toHaveLength(1)
    const [file] = state.openFiles
    expect(file).toMatchObject({ worktreeId: WORKTREE, runtimeEnvironmentId: 'env-1' })
    const tabs = state.unifiedTabsByWorktree[WORKTREE] ?? []
    expect(tabs.map((tab) => tab.entityId)).toEqual([file.id])
    // Same group, same slot: re-owning is not a second tab.
    expect((state.groupsByWorktree[WORKTREE] ?? []).flatMap((group) => group.tabOrder)).toEqual([
      tabs[0]?.id
    ])

    await act(async () => load!(FILE_PATH, file.id, WORKTREE, 'README.md'))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
    expect(mocks.readRuntimeFileContent.mock.calls[0]?.[0]).toMatchObject({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreeId: WORKTREE
    })
    expect(fileContents[file.id]).toMatchObject({ content: '# repo' })
  })

  it('keeps its place and focus among the other restored tabs', async () => {
    seedConvertedWorkspace()
    const readmeId = openRestored(FILE_PATH)
    openRestored('/root/repo/NOTES.md')
    const before = useAppStore.getState()
    const tabIdsBefore = before.unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.id)
    const activeTabBefore = before.groupsByWorktree[WORKTREE]?.[0]?.activeTabId

    await act(async () => load!(FILE_PATH, readmeId, WORKTREE, 'README.md'))

    const after = useAppStore.getState()
    expect(after.unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(tabIdsBefore)
    expect(after.groupsByWorktree[WORKTREE]?.[0]?.activeTabId).toBe(activeTabBefore)
    expect(after.openFiles.map((file) => file.runtimeEnvironmentId ?? null)).toEqual([
      'env-1',
      null
    ])
  })
})
