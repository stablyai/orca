// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { useMarkdownDocuments } from './useMarkdownDocuments'

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
  settings: {},
  repos: [],
  worktreesByRepo: { repo: [{ id: 'wt', path: '/repo' }] },
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (store: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => runtimeConnectionId }))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: runtime.stat }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (_settings: unknown, owner: string | null | undefined) => ({ owner })
}))
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
  await act(async () => {
    root.render(createElement(Harness, { file, viewMode }))
  })
}

beforeEach(() => {
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

  it('preserves actual listing error detail', async () => {
    runtime.list.mockRejectedValueOnce(new Error('SSH listing timed out'))
    await render(sourceFile('edit', 'runtime-owner'), 'source')

    expect(runtime.toastError).toHaveBeenCalledWith('SSH listing timed out')
    expect(runtime.translate).not.toHaveBeenCalled()
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
        settings: { owner: 'runtime-owner' },
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
