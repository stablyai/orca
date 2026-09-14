// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import type { FloatingFileViewer } from './floating-file-viewer-state'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn(),
  route: vi.fn(),
  owner: { kind: 'runtime', environmentId: 'owner', executionHostId: 'runtime:owner' }
}))
vi.mock('@/store', () => ({ useAppStore: (selector: (state: object) => unknown) => selector({}) }))
vi.mock('../right-sidebar/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwnerFromState: () => mocks.owner,
  requireMatchingFileExplorerOperationRoute: mocks.route
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.read,
  subscribeRuntimeFileChanges: mocks.subscribe
}))
import { useFloatingFileContent } from './use-floating-file-content'

const viewer: FloatingFileViewer = {
  id: 'preview',
  filePath: '/repo/a.md',
  relativePath: 'a.md',
  worktreeId: 'folder:remote',
  worktreePath: '/repo',
  language: 'markdown',
  owner: { kind: 'runtime', environmentId: 'owner', executionHostId: 'runtime:owner' },
  projectName: 'Project',
  workspaceName: 'Folder',
  bounds: { left: 80, top: 100, width: 640, height: 480 }
}
let root: Root
let container: HTMLDivElement
let changed: (payload: FsChangedPayload) => void
function Probe({ visible = true }: { visible?: boolean }) {
  const { content, error } = useFloatingFileContent(viewer, visible)
  return createElement('div', null, error ?? content?.content ?? 'loading')
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.route.mockReturnValue({ settings: { activeRuntimeEnvironmentId: 'owner' } })
  mocks.read.mockResolvedValue({ content: 'first', isBinary: false })
  mocks.subscribe.mockImplementation(async (_context, onChange) => {
    changed = onChange
    return vi.fn()
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})
it('pins reads to the captured owner and coalesces matching filesystem changes', async () => {
  await act(async () => root.render(createElement(Probe)))
  expect(mocks.read).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: { activeRuntimeEnvironmentId: 'owner' },
      worktreeId: 'folder:remote'
    })
  )
  expect(container.textContent).toBe('first')
  mocks.read.mockResolvedValue({ content: 'updated', isBinary: false })
  await act(async () => {
    changed({ worktreePath: '/other', events: [{ kind: 'update', absolutePath: '/repo/a.md' }] })
    changed({ worktreePath: '/repo', events: [{ kind: 'update', absolutePath: '/repo/b.md' }] })
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(mocks.read).toHaveBeenCalledTimes(1)
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      changed({ worktreePath: '/repo', events: [{ kind: 'update', absolutePath: '/repo/a.md' }] })
    }
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(mocks.read).toHaveBeenCalledTimes(2)
  expect(container.textContent).toBe('updated')
})
it('does not read hidden windows, and reports owner loss without local fallback', async () => {
  await act(async () => root.render(createElement(Probe, { visible: false })))
  expect(mocks.read).not.toHaveBeenCalled()
  mocks.route.mockImplementation(() => {
    throw new Error('Owner unavailable')
  })
  await act(async () => root.render(createElement(Probe)))
  expect(container.textContent).toBe('Owner unavailable')
  expect(mocks.read).not.toHaveBeenCalled()
})
