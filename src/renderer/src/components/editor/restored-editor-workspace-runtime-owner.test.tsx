// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileReadClient from '@/runtime/files/reads/runtime-file-read-client'
import { useAppStore } from '@/store'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import type { FileContent, EditorPanelFileContentLoader } from './editor-panel-content-types'
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('@/runtime/files/reads/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const WORKTREE = 'repo-1::/root/repo'
const FILE_PATH = '/root/repo/README.md'

/** Simulate unstamped relay-era tabs after their workspace moves to a managed server. */
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
    // Re-own in place without adding a tab or moving its slot.
    expect((state.groupsByWorktree[WORKTREE] ?? []).flatMap((group) => group.tabOrder)).toEqual([
      tabs[0]?.id
    ])

    await act(async () => load!(FILE_PATH, file.id, WORKTREE, 'README.md'))
    expect(mocks.readRuntimeFileContent).toHaveBeenCalledTimes(1)
    expect(mocks.readRuntimeFileContent.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: 'environment', environmentId: 'env-1' },
      worktreeId: WORKTREE
    })
    expect(fileContents[file.id]).toMatchObject({ content: '# repo' })
  })
})
