// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import type { FileContent } from './editor-panel-content-types'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Use main-owned layout frames and move acknowledgments.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const REPO = 'repo-a::/repo-a'
const FOLDER = 'folder:pkg'
const FILE_PATH = '/repo-a/pkg/a.md'
const SERVER_REPO = 'repo-s::/root/repo'

function seedNestedLocalWorkspaces(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields the owner route reads, as restored-editor-owner-save-lifecycle.test.ts uses.
    {
      activeWorktreeId: REPO,
      settings: { editorAutoSave: false },
      repos: [{ id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-a': [{ id: REPO, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }]
      },
      detectedWorktreesByRepo: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      folderWorkspaces: [
        {
          id: 'pkg',
          projectGroupId: 'pkg-group',
          folderPath: '/repo-a/pkg',
          connectionId: null,
          executionHostId: 'local'
        }
      ],
      projectGroups: [{ id: 'pkg-group', name: 'Pkg', executionHostId: 'local' }],
      gitStatusHugeByWorktree: {}
    } as unknown as Partial<AppState>
  )
}

function openAbsoluteTabInFolder(): string {
  return useAppStore.getState().openFile(
    {
      filePath: FILE_PATH,
      relativePath: FILE_PATH,
      worktreeId: FOLDER,
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

let main: TabsDrawnFromMain | null = null
let sentBefore = 0

/** Main takes the seeded layout; the tab the test opens is drawn from its frame. */
async function drawFromMain<T>(open: () => T): Promise<T> {
  main = await drawTabsFromMain(useAppStore)
  const opened = open()
  await main.settle()
  sentBefore = layoutApplyTestTransport.sent.length
  return opened
}

function layoutCommands(): unknown[] {
  return layoutApplyTestTransport.sent.slice(sentBefore)
}

/** Simulate unstamped relay-era tabs whose workspace has moved to a managed server. */
function seedServerWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: SERVER_REPO,
    repos: [
      {
        id: 'repo-s',
        path: '/root/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:env-1'
      }
    ],
    worktreesByRepo: {
      'repo-s': [
        makeWorktree({
          id: SERVER_REPO,
          repoId: 'repo-s',
          path: '/root/repo',
          hostId: 'runtime:env-1',
          runtimeOwnerEnvironmentId: 'env-1'
        })
      ]
    }
  })
}

function fileIdentities() {
  return useAppStore.getState().openFiles.map(({ id, worktreeId, relativePath }) => ({
    id,
    worktreeId,
    relativePath
  }))
}

describe('a restored tab re-owned inside its own workspace, layout-owner build', () => {
  let container: HTMLDivElement
  let root: Root
  let load: EditorPanelFileContentLoader | null
  let fileContents: Record<string, FileContent>

  beforeEach(() => {
    mocks.readRuntimeFileContent.mockReset()
    mocks.readRuntimeFileContent.mockResolvedValue({ content: '# a', isBinary: false })
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
    main?.close()
    main = null
    act(() => root.unmount())
    container.remove()
  })

  it('keeps a local tab where it is when loaded for its own workspace', async () => {
    seedNestedLocalWorkspaces()
    const id = await drawFromMain(openAbsoluteTabInFolder)
    const before = fileIdentities()

    await act(async () => load!(FILE_PATH, id, FOLDER, FILE_PATH))

    expect(fileIdentities()).toEqual(before)
    expect(fileContents[id]).toMatchObject({ content: '# a' })
    expect(layoutCommands()).toEqual([])
  })

  it("tells main when a parent workspace's conflict review re-owns a local tab in place", async () => {
    seedNestedLocalWorkspaces()
    const id = await drawFromMain(openAbsoluteTabInFolder)
    expect(id).toBe(FILE_PATH)
    expect(useAppStore.getState().unifiedTabsByWorktree[FOLDER]).toEqual([
      expect.objectContaining({ entityId: id })
    ])

    // The conflict review's read: its id is the bare path, its workspace the review's.
    await act(async () => load!(FILE_PATH, FILE_PATH, REPO, 'pkg/a.md'))
    await main!.settle()

    const [file] = useAppStore.getState().openFiles
    expect(file).toMatchObject({ worktreeId: FOLDER, relativePath: 'a.md' })
    expect(file!.id).not.toBe(id)
    expect(useAppStore.getState().unifiedTabsByWorktree[FOLDER]).toEqual([
      expect.objectContaining({ entityId: file!.id })
    ])
    expect(layoutCommands()).toEqual([
      {
        type: 'renameEditorFiles',
        workspace: FOLDER,
        renames: [
          {
            fileId: id,
            newFileId: file!.id,
            record: {
              fromFilePath: FILE_PATH,
              file: expect.objectContaining({ filePath: FILE_PATH, relativePath: 'a.md' })
            }
          }
        ]
      }
    ])
  })

  it("tells main of a re-own that reaches a tab before main's frame draws it", async () => {
    seedNestedLocalWorkspaces()
    main = await drawTabsFromMain(useAppStore)
    // Hold the open acknowledgment so re-owning must wait for main to draw the tab.
    layoutApplyTestTransport.answerWith('pending')
    const id = openAbsoluteTabInFolder()
    expect(useAppStore.getState().unifiedTabsByWorktree[FOLDER] ?? []).toEqual([])

    let loading: Promise<void> | null = null
    await act(async () => {
      loading = load!(FILE_PATH, FILE_PATH, REPO, 'pkg/a.md')
      await Promise.resolve()
    })
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await act(async () => {
      await main!.settle()
      await loading
      await main!.settle()
    })

    const [file] = useAppStore.getState().openFiles
    expect(file).toMatchObject({ worktreeId: FOLDER, relativePath: 'a.md' })
    expect(file!.id).not.toBe(id)
    expect(layoutApplyTestTransport.sentOfType('renameEditorFiles')).toEqual([
      expect.objectContaining({
        workspace: FOLDER,
        renames: [expect.objectContaining({ fileId: id, newFileId: file!.id })]
      })
    ])
    expect(useAppStore.getState().unifiedTabsByWorktree[FOLDER]).toEqual([
      expect.objectContaining({ entityId: file!.id })
    ])
  })

  it("sends nothing for a paired server's tab, whose layout main does not own", async () => {
    seedServerWorkspace()
    const id = await drawFromMain(() =>
      useAppStore.getState().openFile(
        {
          filePath: '/root/repo/README.md',
          relativePath: 'README.md',
          worktreeId: SERVER_REPO,
          runtimeEnvironmentId: null,
          language: 'markdown',
          mode: 'edit'
        },
        { suppressActiveRuntimeFallback: true }
      )
    )

    await act(async () => load!('/root/repo/README.md', id, SERVER_REPO, 'README.md'))

    expect(useAppStore.getState().openFiles[0]).toMatchObject({
      worktreeId: SERVER_REPO,
      runtimeEnvironmentId: 'env-1'
    })
    expect(layoutCommands()).toEqual([])
  })
})
