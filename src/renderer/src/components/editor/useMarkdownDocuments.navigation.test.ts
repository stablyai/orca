// @vitest-environment happy-dom
import { act, createElement, StrictMode, Suspense, use } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { useMarkdownDocuments } from './useMarkdownDocuments'
import type * as MarkdownDocumentListRequest from './markdown-document-list-request'

const runtime = vi.hoisted(() => ({
  stat: vi.fn(),
  list: vi.fn()
}))
let runtimeConnectionId: string | null = null
const target = {
  filePath: '/repo/target.md',
  relativePath: 'target.md',
  basename: 'target.md',
  name: 'target'
}
const state = {
  settings: {},
  worktreesByRepo: { repo: [{ id: 'wt', path: '/repo' }] },
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (store: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => runtimeConnectionId }))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: runtime.stat }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (_settings: unknown, owner: string | null | undefined) => ({
    activeRuntimeEnvironmentId: owner
  })
}))
vi.mock('./markdown-document-list-request', async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownDocumentListRequest>()),
  requestSharedMarkdownDocumentList: runtime.list
}))

let root: Root
let container: HTMLDivElement
let controller: ReturnType<typeof useMarkdownDocuments>
const save = vi.fn(async () => true)

function PreviewHydration({ pending }: { pending?: Promise<void> }): null {
  if (pending) {
    use(pending)
  }
  return null
}

function Harness({
  file,
  viewMode,
  pending
}: {
  file: OpenFile
  viewMode: MarkdownViewMode
  pending?: Promise<void>
}): React.JSX.Element {
  controller = useMarkdownDocuments(file, true, viewMode, save)
  return createElement(PreviewHydration, { pending })
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

async function render(
  file: OpenFile,
  viewMode: MarkdownViewMode,
  pending?: Promise<void>
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        Suspense,
        { fallback: null },
        createElement(Harness, { file, viewMode, pending })
      )
    )
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  runtimeConnectionId = null
  state.worktreesByRepo = { repo: [{ id: 'wt', path: '/repo' }] }
  runtime.stat.mockResolvedValue({ isDirectory: false })
  runtime.list.mockResolvedValue([target])
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
  it('loads the current index after Strict Mode replays mount effects', async () => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Harness, {
            file: sourceFile('edit'),
            viewMode: 'source'
          })
        )
      )
    })

    expect(controller.markdownDocuments).toEqual([target])
  })

  it('does not start a document scan when a save finishes after permanent unmount', async () => {
    await render(sourceFile('edit'), 'source')
    let releaseSave: (saved: boolean) => void = () => {
      throw new Error('Missing save request')
    }
    save.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseSave = resolve
        })
    )
    const pendingSave = controller.mdSave('updated content')
    act(() => root.unmount())
    releaseSave(true)

    expect(await pendingSave).toBe(true)
    expect(runtime.list).toHaveBeenCalledTimes(1)
  })

  it('keeps a current scan response while its preview suspends', async () => {
    await render(sourceFile('edit'), 'source')
    const refreshed = { ...target, name: 'refreshed' }
    let releaseList: () => void = () => {
      throw new Error('Missing document scan')
    }
    runtime.list.mockImplementationOnce(
      () =>
        new Promise<typeof controller.markdownDocuments>((resolve) => {
          releaseList = () => resolve([refreshed])
        })
    )
    const pendingSave = controller.mdSave('updated content')
    let reveal: () => void = () => {
      throw new Error('Missing preview hydration')
    }
    const hydration = new Promise<void>((resolve) => {
      reveal = resolve
    })
    await render(sourceFile('edit'), 'source', hydration)
    await act(async () => {
      releaseList()
      expect(await pendingSave).toBe(true)
    })
    await act(async () => {
      reveal()
    })

    expect(controller.markdownDocuments).toEqual([refreshed])
  })

  it.each([false, true])(
    'keeps the current workspace index when an earlier save finishes (current scan pending: %s)',
    async (scanPending) => {
      const secondTarget = { ...target, filePath: '/second/target.md' }
      state.worktreesByRepo = {
        repo: [
          { id: 'wt', path: '/repo' },
          { id: 'second', path: '/second' }
        ]
      }
      await render(sourceFile('edit'), 'source')
      let releaseSave: (saved: boolean) => void = () => {
        throw new Error('Missing save request')
      }
      save.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseSave = resolve
          })
      )
      const oldSave = controller.mdSave('old content')
      let releaseList = (): void => {}
      runtime.list.mockImplementationOnce(() =>
        scanPending
          ? new Promise<typeof controller.markdownDocuments>((resolve) => {
              releaseList = () => resolve([secondTarget])
            })
          : Promise.resolve([secondTarget])
      )
      await render({ ...sourceFile('edit'), id: 'second-source', worktreeId: 'second' }, 'source')
      await act(async () => {
        releaseSave(true)
        expect(await oldSave).toBe(true)
        releaseList()
      })

      expect(controller.markdownDocuments).toEqual([secondTarget])
      expect(runtime.list).toHaveBeenCalledTimes(2)
    }
  )

  it('does not reuse a document index from another runtime owner while loading', async () => {
    await render(sourceFile('edit', 'first-host'), 'source')
    expect(controller.markdownDocuments).toEqual([target])
    runtime.list.mockImplementationOnce(() => new Promise(() => {}))

    await render(sourceFile('edit', 'second-host'), 'source')

    expect(controller.markdownDocuments).toEqual([])
    controller.onOpenDocLink('target')
    expect(runtime.stat).not.toHaveBeenCalled()
  })

  it('does not reuse a document index from another SSH connection while loading', async () => {
    runtimeConnectionId = 'first-connection'
    await render(sourceFile('edit', 'ssh-host'), 'source')
    runtime.list.mockImplementationOnce(() => new Promise(() => {}))
    runtimeConnectionId = 'second-connection'

    await render(sourceFile('edit', 'ssh-host'), 'source')

    expect(controller.markdownDocuments).toEqual([])
  })

  it('discards the prior workspace index instead of retaining it for a later visit', async () => {
    state.worktreesByRepo = {
      repo: [...state.worktreesByRepo.repo, { id: 'second', path: '/second' }]
    }
    await render(sourceFile('edit'), 'source')
    await render({ ...sourceFile('edit'), id: 'second-source', worktreeId: 'second' }, 'source')
    runtime.list.mockImplementationOnce(() => new Promise(() => {}))

    await render(sourceFile('edit'), 'source')

    expect(controller.markdownDocuments).toEqual([])
  })

  it('releases document snapshots from previously visited workspaces', async () => {
    const collect = globalThis.gc
    if (!collect) {
      throw new Error('The retention check requires the configured exposed GC')
    }
    state.worktreesByRepo = {
      repo: Array.from({ length: 40 }, (_, index) => ({
        id: `wt-${index}`,
        path: `/repo-${index}`
      }))
    }
    const snapshots: WeakRef<ReturnType<typeof useMarkdownDocuments>['markdownDocuments']>[] = []
    for (let index = 0; index < 40; index += 1) {
      runtime.list.mockResolvedValueOnce([{ ...target, filePath: `/repo-${index}/target.md` }])
      await render(
        { ...sourceFile('edit'), id: `source-${index}`, worktreeId: `wt-${index}` },
        'source'
      )
      snapshots.push(new WeakRef(controller.markdownDocuments))
      runtime.list.mockClear()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    collect()

    expect(snapshots.filter((snapshot) => snapshot.deref()).length).toBeLessThanOrEqual(2)
    expect(controller.markdownDocuments).toEqual([{ ...target, filePath: '/repo-39/target.md' }])
  })

  it.each([
    ['markdown-preview', 'source'],
    ['edit', 'preview'],
    ['diff', 'preview']
  ] as const)('preserves preview from %s / %s without a fragment', async (mode, viewMode) => {
    await render(sourceFile(mode), viewMode)
    await act(async () => {
      await controller.previewProps.onOpenDocument(target)
    })

    expect(state.openMarkdownPreview).toHaveBeenCalledWith(
      {
        filePath: target.filePath,
        relativePath: target.relativePath,
        worktreeId: 'wt',
        language: 'markdown',
        runtimeEnvironmentId: null
      },
      { anchor: undefined }
    )
    expect(state.openFile).not.toHaveBeenCalled()
  })

  it.each(['source', 'rich'] as const)(
    'keeps plain links from %s editing in edit mode',
    async (viewMode) => {
      await render(sourceFile('edit'), viewMode)
      await act(async () => {
        await controller.openMarkdownDocument(target)
      })

      expect(state.openFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: target.filePath,
          mode: 'edit',
          worktreeId: 'wt',
          runtimeEnvironmentId: null
        })
      )
      expect(state.openMarkdownPreview).not.toHaveBeenCalled()
    }
  )

  it.each(['source', 'rich', 'preview'] as const)(
    'keeps anchored links from %s in preview',
    async (viewMode) => {
      await render(sourceFile('edit'), viewMode)
      await act(async () => {
        await controller.openMarkdownDocument(target, { anchor: 'target' })
      })

      expect(state.openMarkdownPreview).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: target.filePath }),
        { anchor: 'target' }
      )
      expect(state.openFile).not.toHaveBeenCalled()
    }
  )

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

  it('retains SSH and runtime ownership for an indexed wiki link', async () => {
    runtimeConnectionId = 'ssh-owner'
    await render(sourceFile('markdown-preview', 'runtime-owner'), 'source')
    await act(async () => {
      controller.onOpenDocLink('target')
    })

    expect(runtime.stat).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: 'runtime-owner' },
        worktreeId: 'wt',
        worktreePath: '/repo',
        connectionId: 'ssh-owner'
      },
      target.filePath
    )
    expect(state.openMarkdownPreview).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt', runtimeEnvironmentId: 'runtime-owner' }),
      { anchor: null }
    )
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

  it('does not navigate when the source workspace cannot be resolved', async () => {
    await render({ ...sourceFile('markdown-preview'), worktreeId: 'unknown' }, 'source')
    await act(async () => {
      await controller.previewProps.onOpenDocument(target)
    })

    expect(runtime.stat).not.toHaveBeenCalled()
    expect(state.openFile).not.toHaveBeenCalled()
    expect(state.openMarkdownPreview).not.toHaveBeenCalled()
  })
})
