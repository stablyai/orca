import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ statUserOpenedPath: vi.fn(), openFile: vi.fn() }))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/user-opened-local-path', () => ({ statUserOpenedPath: mocks.statUserOpenedPath }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      getKnownWorktreeById: (id: string) => (id === 'wt-1' ? { id, path: '/repo' } : undefined),
      setActiveTabType: vi.fn(),
      ensureWorktreeRootGroup: () => 'group-1',
      openFile: mocks.openFile
    })
  }
}))

import { navigateBrowserPageToUrl } from './navigate-browser-page-url'

function ref<T>(current: T): { current: T } {
  return { current }
}

function openNotebookUrl(url: string): void {
  navigateBrowserPageToUrl({
    url,
    browserTabId: 'tab-1',
    worktreeId: 'wt-1',
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref(null),
    trackNextLoadingEventRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    webviewRef: ref(null),
    onSetUrlRef: ref(vi.fn()),
    onUpdatePageStateRef: ref(vi.fn()),
    setAddressBarValueFromSubmit: vi.fn(),
    setResourceNotice: vi.fn(),
    focusWebviewNow: () => true
  })
}

describe('opening a file:// notebook from the browser', () => {
  beforeEach(() => {
    mocks.statUserOpenedPath.mockReset()
    mocks.openFile.mockReset()
  })

  it('opens a project link that leads out of the project by its absolute path', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: true })

    openNotebookUrl('file:///repo/notebooks-link/analysis.ipynb')
    await vi.waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/notebooks-link/analysis.ipynb',
        relativePath: '/repo/notebooks-link/analysis.ipynb'
      }),
      expect.anything()
    )
  })

  it('keeps an ordinary project notebook project-relative', async () => {
    mocks.statUserOpenedPath.mockResolvedValue({ isDirectory: false, escapesWorktree: false })

    openNotebookUrl('file:///repo/analysis.ipynb')
    await vi.waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(1))

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/analysis.ipynb', relativePath: 'analysis.ipynb' }),
      expect.anything()
    )
  })
})
