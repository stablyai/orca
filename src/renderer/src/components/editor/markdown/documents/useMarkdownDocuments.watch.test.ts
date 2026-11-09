// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import type * as ConnectionOwnerResolution from '@/lib/workspace/ownership/connection-owner-resolution'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const runtime = vi.hoisted(() => ({ list: vi.fn(), stat: vi.fn() }))
const state = {
  settings: {},
  worktreesByRepo: { repo: [{ id: 'wt', path: '/repo' }] },
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn()
}
vi.mock('@/store/index', () => ({
  useAppStore: Object.assign((selector: (store: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdFromState: () => null
}))
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionOwnerResolution>()
  return { ...actual, getConnectionIdFromState: () => null }
})
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  listRuntimeMarkdownDocuments: runtime.list,
  statRuntimePath: runtime.stat
}))
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
})
