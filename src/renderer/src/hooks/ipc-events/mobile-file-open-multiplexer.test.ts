// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useFloatingFileViewers } from '@/components/floating-file-viewer/floating-file-viewer-state'
import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
let open: Parameters<typeof window.api.ui.onOpenFileFromMobile>[0]
const originalApi = window.api
const previous = useAppStore.getState()
const payload = { worktreeId: 'wt', filePath: '/repo/readme.md', relativePath: 'readme.md' }
beforeEach(() => {
  vi.clearAllMocks()
  window.api = {
    ui: new Proxy(
      {},
      {
        get: (_target, key) => (callback: typeof open) => {
          if (key === 'onOpenFileFromMobile') {
            open = callback
          }
          return () => {}
        }
      }
    )
  } as typeof window.api
  useFloatingFileViewers.setState({ viewers: [], hidden: false })
  useAppStore.setState({
    activeView: 'multiplexer',
    activeWorktreeId: 'other',
    repos: [
      { id: 'repo', path: '/repo', displayName: 'Project', executionHostId: 'local' } as never
    ],
    worktreesByRepo: {
      repo: [{ id: 'wt', repoId: 'repo', path: '/repo', hostId: 'local', branch: 'topic' } as never]
    },
    setActiveWorktree: vi.fn(),
    markWorktreeVisited: vi.fn(),
    setActiveView: vi.fn(),
    openFile: vi.fn(),
    setActiveTabType: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  })
  registerMobileAndTerminalCloseIpcBridge([], vi.fn())
})
afterEach(() => {
  window.api = originalApi
  useAppStore.setState(previous, true)
  useFloatingFileViewers.setState({ viewers: [], hidden: false })
})
it('opens and raises a read-only viewer without changing the focused workspace or screen', () => {
  open(payload)
  useFloatingFileViewers.getState().toggleHidden()
  open(payload)
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(1)
  expect(useFloatingFileViewers.getState().viewers[0]).toMatchObject({
    worktreeId: 'wt',
    filePath: payload.filePath,
    owner: { kind: 'local' }
  })
  expect(useFloatingFileViewers.getState().hidden).toBe(false)
  expect(useAppStore.getState().setActiveWorktree).not.toHaveBeenCalled()
  expect(useAppStore.getState().setActiveView).not.toHaveBeenCalled()
  expect(useAppStore.getState().openFile).not.toHaveBeenCalled()
})
it('keeps the normal editor flow outside the multiplexer', () => {
  useAppStore.setState({ activeView: 'terminal' })
  open(payload)
  expect(useAppStore.getState().setActiveWorktree).toHaveBeenCalledWith('wt')
  expect(useAppStore.getState().openFile).toHaveBeenCalledWith(
    expect.objectContaining({ ...payload, mode: 'edit' })
  )
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(0)
})
it('rejects mismatched runtime ownership without falling back to the editor or local files', () => {
  open({ ...payload, runtimeEnvironmentId: 'another-host' })
  expect(toast.error).toHaveBeenCalled()
  expect(useFloatingFileViewers.getState().viewers).toHaveLength(0)
  expect(useAppStore.getState().openFile).not.toHaveBeenCalled()
})
