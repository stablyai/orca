// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor/types/open-file'
import type * as ConnectionOwnerResolution from '@/lib/connection-owner-resolution'
import { useMarkdownDocuments } from './useMarkdownDocuments'
import { useAppStore } from '@/store/index'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'

const runtime = vi.hoisted(() => ({
  stat: vi.fn(),
  list: vi.fn(),
  toastError: vi.fn(),
  translate: vi.fn()
}))
let runtimeConnectionId: string | null = null
const target = {
  filePath: '/repo/target.md',
  relativePath: 'target.md',
  basename: 'target.md',
  name: 'target'
}
const state = {
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn()
}
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => runtimeConnectionId }))
vi.mock('@/lib/connection-owner-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionOwnerResolution>()
  return { ...actual, getConnectionIdFromState: () => runtimeConnectionId }
})
vi.mock('@/runtime/runtime-file-metadata-client', () => ({ statRuntimePath: runtime.stat }))
vi.mock('@/lib/file-owner-runtime-target', () => {
  const getRuntimeTargetForFileOwner = (
    _state: unknown,
    _worktreeId: string | null | undefined,
    owner: string | null | undefined
  ) => (owner ? { kind: 'environment' as const, environmentId: owner } : { kind: 'local' as const })
  return {
    FILE_OWNER_UNRESOLVED_MESSAGE: 'unresolved',
    getRuntimeTargetForFileOwner,
    requireRuntimeTargetForFileOwner: getRuntimeTargetForFileOwner,
    getRuntimeTargetForWorktreeOwner: (state: unknown, worktreeId: string | null | undefined) =>
      getRuntimeTargetForFileOwner(state, worktreeId, undefined)
  }
})
vi.mock('./markdown-document-list-request', () => ({
  requestSharedMarkdownDocumentList: runtime.list
}))
vi.mock('sonner', () => ({ toast: { error: runtime.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: runtime.translate }))

let root: Root
let container: HTMLDivElement
let controller: ReturnType<typeof useMarkdownDocuments>
const save = vi.fn(async () => true)

function Harness({ file, viewMode }: { file: OpenFile; viewMode: MarkdownViewMode }): null {
  controller = useMarkdownDocuments(file, true, viewMode, save)
  return null
}

function sourceFile(mode: OpenFile['mode'], runtimeEnvironmentId: string | null = null): OpenFile {
  return {
    id: 'source',
    filePath: '/repo/source.md',
    relativePath: 'source.md',
    worktreeId: 'wt',
    language: 'markdown',
    isDirty: false,
    mode,
    runtimeEnvironmentId
  }
}

async function render(file: OpenFile, viewMode: MarkdownViewMode): Promise<void> {
  const environmentId = file.runtimeEnvironmentId ?? null
  const executionHostId = environmentId
    ? (`runtime:${environmentId}` as const)
    : runtimeConnectionId
      ? (`ssh:${runtimeConnectionId}` as const)
      : ('local' as const)
  const connections = new Map(
    runtimeConnectionId
      ? [
          [
            runtimeConnectionId,
            {
              targetId: runtimeConnectionId,
              status: 'connected' as const,
              error: null,
              reconnectAttempt: 0,
              connectionGeneration: 7
            }
          ]
        ]
      : []
  )
  useAppStore.setState({
    ...state,
    openFiles: [file],
    repos: [
      {
        ...TEST_REPO,
        id: 'repo',
        path: '/repo',
        executionHostId,
        connectionId: runtimeConnectionId
      }
    ],
    worktreesByRepo: {
      repo: [
        makeWorktree({
          id: 'wt',
          repoId: 'repo',
          path: '/repo',
          hostId: runtimeConnectionId ? `ssh:${runtimeConnectionId}` : executionHostId,
          runtimeOwnerEnvironmentId: environmentId ?? undefined
        })
      ]
    },
    sshConnectionStates: connections,
    sshStateByEnvironment: new Map(
      environmentId && runtimeConnectionId
        ? [
            [
              environmentId,
              {
                targetsHydrated: true,
                targetLabels: new Map([[runtimeConnectionId, 'Box']]),
                targetGenerations: new Map([[runtimeConnectionId, 7]]),
                removedTargetLabels: new Map(),
                connectionStates: connections
              }
            ]
          ]
        : []
    )
  })
  await act(async () => {
    root.render(createElement(Harness, { file, viewMode }))
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  runtimeConnectionId = null
  runtime.stat.mockResolvedValue({ isDirectory: false })
  runtime.list.mockResolvedValue([target])
  runtime.translate.mockReturnValue('Localized listing failure')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Markdown document navigation', () => {
  it.each(['source-replaced', 'authority-replaced'])(
    'does not open a delayed stat result after %s',
    async (reason) => {
      runtimeConnectionId = 'box'
      const source = sourceFile('edit')
      await render(source, 'source')
      let finish!: (value: { isDirectory: boolean }) => void
      runtime.stat.mockReturnValueOnce(
        new Promise<{ isDirectory: boolean }>((resolve) => {
          finish = resolve
        })
      )
      const pending = controller.openMarkdownDocument(target)
      expect(runtime.stat).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'box',
          expectedExecutionHostId: 'ssh:box',
          expectedSshConnectionGeneration: 7
        }),
        target.filePath
      )
      if (reason === 'source-replaced') {
        useAppStore.setState({
          openFiles: [
            { ...source, filePath: '/repo/replacement.md', relativePath: 'replacement.md' }
          ]
        })
      } else {
        useAppStore.setState((current) => ({
          repos: current.repos.map((repo) => ({
            ...repo,
            executionHostId: 'ssh:other' as const,
            connectionId: 'other'
          })),
          worktreesByRepo: {
            repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: '/repo', hostId: 'ssh:other' })]
          }
        }))
      }
      await act(async () => {
        finish({ isDirectory: false })
        await pending
      })
      expect(state.openFile).not.toHaveBeenCalled()
      expect(state.openMarkdownPreview).not.toHaveBeenCalled()
    }
  )
  it('localizes a non-Error failure at settlement without restarting the request', async () => {
    let rejectListing: (reason: unknown) => void = () => {}
    runtime.list.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectListing = reject
      })
    )
    await render(sourceFile('edit'), 'source')
    runtime.translate.mockReturnValue('Current language listing failure')
    await render(sourceFile('edit'), 'source')
    await act(async () => rejectListing(null))

    expect(runtime.list).toHaveBeenCalledOnce()
    expect(runtime.translate).toHaveBeenCalledWith(
      'auto.components.editor.useMarkdownDocuments.listFailed',
      'Failed to list Markdown documents.'
    )
    expect(runtime.toastError).toHaveBeenCalledWith('Current language listing failure')
    expect(controller.markdownDocuments).toEqual([])
  })

  it.each(['superseded', 'unmounted'])('ignores a %s listing failure', async (reason) => {
    let rejectListing: (error: unknown) => void = () => {}
    runtime.list.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectListing = reject
      })
    )
    await render(sourceFile('edit'), 'source')
    await (reason === 'superseded'
      ? render(sourceFile('edit', 'next-owner'), 'source')
      : act(async () => root.render(null)))
    await act(async () => rejectListing(null))

    expect(runtime.toastError).not.toHaveBeenCalled()
    expect(runtime.translate).not.toHaveBeenCalled()
    if (reason === 'superseded') {
      expect(controller.markdownDocuments).toEqual([target])
    }
  })

  it('uses the new source mode after a rerender', async () => {
    await render(sourceFile('markdown-preview'), 'source')
    await render(sourceFile('edit'), 'source')
    await act(async () => {
      await controller.openMarkdownDocument(target)
    })
    expect(state.openFile).toHaveBeenCalledOnce()
    expect(state.openMarkdownPreview).not.toHaveBeenCalled()

    state.openFile.mockClear()
    await render(sourceFile('edit'), 'preview')
    await act(async () => {
      await controller.openMarkdownDocument(target)
    })
    expect(state.openMarkdownPreview).toHaveBeenCalledOnce()
    expect(state.openFile).not.toHaveBeenCalled()
  })

  it.each(['directory', 'missing'])('does not navigate to a %s destination', async (kind) => {
    await render(sourceFile('markdown-preview'), 'source')
    if (kind === 'directory') {
      runtime.stat.mockResolvedValue({ isDirectory: true })
    } else {
      runtime.stat.mockRejectedValue(new Error('missing'))
    }
    await act(async () => {
      await controller.previewProps.onOpenDocument(target)
    })

    expect(runtime.list).toHaveBeenLastCalledWith(expect.anything(), '/repo', {
      requireFresh: true
    })
    expect(state.openFile).not.toHaveBeenCalled()
    expect(state.openMarkdownPreview).not.toHaveBeenCalled()
  })
})
