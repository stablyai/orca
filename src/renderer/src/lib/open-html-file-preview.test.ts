import { beforeEach, expect, it, vi } from 'vitest'
import { openHtmlFilePreview } from './open-html-file-preview'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  open: vi.fn(),
  select: vi.fn(),
  state: { activeWorktreeId: 'current' }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./workspace-doc-address-input', () => ({
  resolveWorkspaceDocAddressTarget: mocks.resolve
}))
vi.mock('./file-preview', () => ({ openFileInBrowserTab: mocks.open }))
vi.mock('./workspace-surface-reveal', () => ({ selectWorkspaceSurface: mocks.select }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReturnValue({ status: 'not-a-workspace-doc' })
  mocks.open.mockReturnValue({ status: 'browser-tab' })
})

const request = {
  filePath: '/repo/report one.html',
  worktreeId: 'current',
  targetGroupId: 'group-2'
}

it('keeps a local HTML preview in the requested group', () => {
  openHtmlFilePreview(request)
  expect(mocks.resolve).toHaveBeenCalledWith(mocks.state, 'current', request.filePath)
  expect(mocks.open).toHaveBeenCalledWith(request)
  expect(mocks.select).not.toHaveBeenCalled()
})

it('opens a sibling remote document in its owning workspace', () => {
  mocks.resolve.mockReturnValue({ status: 'workspace-doc', docLocation: { worktreeId: 'sibling' } })
  mocks.open.mockReturnValue({ status: 'doc-preview' })
  openHtmlFilePreview(request)
  expect(mocks.select).toHaveBeenCalledWith(mocks.state, 'sibling')
  expect(mocks.open).toHaveBeenCalledWith({ filePath: request.filePath, worktreeId: 'sibling' })
})

it('reports a refused host without creating a preview', () => {
  mocks.resolve.mockReturnValue({ status: 'unsupported', message: 'outside workspace' })
  expect(() => openHtmlFilePreview(request)).toThrow('outside workspace')
  expect(mocks.open).not.toHaveBeenCalled()
})

it('reports a preview plan refusal', () => {
  mocks.open.mockReturnValue({ status: 'unsupported', message: 'unknown host' })
  expect(() => openHtmlFilePreview(request)).toThrow('unknown host')
})
