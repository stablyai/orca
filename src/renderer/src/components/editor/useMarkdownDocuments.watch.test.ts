// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent, MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { OpenFile } from '@/store/slices/editor'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const runtime = vi.hoisted(() => ({ list: vi.fn(), stat: vi.fn() }))
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
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeMarkdownDocuments: runtime.list,
  statRuntimePath: runtime.stat
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (_settings: unknown, owner: string | null | undefined) => ({
    activeRuntimeEnvironmentId: owner
  })
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const target: MarkdownDocument = {
  filePath: '/repo/LATE.md',
  relativePath: 'LATE.md',
  basename: 'LATE.md',
  name: 'LATE'
}
let root: Root
let container: HTMLDivElement
const controllers: ReturnType<typeof useMarkdownDocuments>[] = []
function Harness({ owner, pane }: { owner: string | null; pane: number }): null {
  const file: OpenFile = {
    id: `source-${pane}`,
    filePath: '/repo/README.md',
    relativePath: 'README.md',
    worktreeId: 'wt',
    language: 'markdown',
    isDirty: false,
    mode: 'markdown-preview',
    runtimeEnvironmentId: owner
  }
  controllers[pane] = useMarkdownDocuments(file, true, 'preview', async () => true)
  return null
}
async function render(owner: string | null = 'host-a', panes = 1): Promise<void> {
  await act(async () =>
    root.render(
      Array.from({ length: panes }, (_, pane) => createElement(Harness, { key: pane, owner, pane }))
    )
  )
}
function change(
  events: FsChangeEvent[],
  owner: string | null = 'host-a',
  rootPath = '/repo'
): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: { runtimeEnvironmentId: owner, payload: { worktreePath: rootPath, events } }
    })
  )
}
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(125)
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.clearAllMocks()
  runtime.list.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Markdown metadata from the existing worktree watcher', () => {
  it('discovers a created document and removes a deleted document without reopening', async () => {
    await render()
    runtime.list.mockResolvedValueOnce([target])
    change([{ kind: 'create', absolutePath: target.filePath }])
    await settle()
    expect(controllers[0].markdownDocuments).toEqual([target])
    change([{ kind: 'delete', absolutePath: target.filePath }])
    await settle()
    expect(controllers[0].markdownDocuments).toEqual([])
    expect(runtime.list).toHaveBeenCalledTimes(3)
  })

  it('keeps the last list without a toast when a watcher refresh fails', async () => {
    runtime.list.mockResolvedValueOnce([target])
    await render()
    expect(controllers[0].markdownDocuments).toEqual([target])
    runtime.list.mockRejectedValueOnce(new Error('host unreachable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    change([{ kind: 'create', absolutePath: '/repo/OTHER.md' }])
    await settle()
    expect(controllers[0].markdownDocuments).toEqual([target])
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps a late pre-change scan from replacing the refreshed document list', async () => {
    let resolveOld: (documents: MarkdownDocument[]) => void = () => {}
    runtime.list.mockReturnValueOnce(
      new Promise<MarkdownDocument[]>((done) => {
        resolveOld = done
      })
    )
    await render()
    runtime.list.mockResolvedValueOnce([target])
    change([{ kind: 'create', absolutePath: target.filePath }])
    await settle()
    expect(controllers[0].markdownDocuments).toEqual([target])
    await act(async () => resolveOld([]))
    expect(controllers[0].markdownDocuments).toEqual([target])
    expect(runtime.list).toHaveBeenCalledTimes(2)
  })

  it('refreshes a local owner while ignoring an identical remote path', async () => {
    await render(null)
    change([{ kind: 'create', absolutePath: target.filePath }], 'host-a')
    await settle()
    expect(runtime.list).toHaveBeenCalledOnce()
    runtime.list.mockResolvedValueOnce([target])
    change([{ kind: 'create', absolutePath: target.filePath }], null)
    await settle()
    expect(controllers[0].markdownDocuments).toEqual([target])
    expect(runtime.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: { activeRuntimeEnvironmentId: null } }),
      '/repo'
    )
  })

  it('ignores other hosts, roots, unrelated files, and ordinary content updates', async () => {
    await render()
    change([{ kind: 'create', absolutePath: target.filePath }], 'host-b')
    change([{ kind: 'create', absolutePath: target.filePath }], null)
    change([{ kind: 'create', absolutePath: '/other/LATE.md' }], 'host-a', '/other')
    change([{ kind: 'create', absolutePath: '/repo-other/LATE.md' }])
    change([{ kind: 'create', absolutePath: '/repo/app.ts' }])
    change([{ kind: 'update', absolutePath: target.filePath }])
    await settle()
    expect(runtime.list).toHaveBeenCalledOnce()
  })

  it.each([
    { kind: 'rename', absolutePath: '/repo/LATE.txt', oldAbsolutePath: target.filePath },
    { kind: 'create', absolutePath: '/repo/late.MDX' },
    { kind: 'delete', absolutePath: '/repo/docs', isDirectory: true },
    { kind: 'overflow', absolutePath: '/repo' }
  ] satisfies FsChangeEvent[])(
    'refreshes document membership for $kind $absolutePath',
    async (event) => {
      await render()
      change([event])
      await settle()
      expect(runtime.list).toHaveBeenCalledTimes(2)
    }
  )

  it('coalesces bursts and shares a fresh pending scan across split panes', async () => {
    await render('host-a', 2)
    let resolve: (documents: MarkdownDocument[]) => void = () => {}
    runtime.list.mockReturnValueOnce(
      new Promise<MarkdownDocument[]>((done) => {
        resolve = done
      })
    )
    change([{ kind: 'create', absolutePath: target.filePath }])
    change([{ kind: 'delete', absolutePath: '/repo/old.markdown' }])
    await settle()
    expect(runtime.list).toHaveBeenCalledTimes(2)
    await act(async () => resolve([target]))
    expect(controllers.map((controller) => controller.markdownDocuments)).toEqual([
      [target],
      [target]
    ])
  })

  it.each(['unmount', 'owner change'])('cancels scheduled scans on %s', async (reason) => {
    await render()
    change([{ kind: 'create', absolutePath: target.filePath }])
    await (reason === 'unmount' ? act(async () => root.render(null)) : render('host-b'))
    const calls = runtime.list.mock.calls.length
    await settle()
    expect(runtime.list).toHaveBeenCalledTimes(calls)
  })
})
