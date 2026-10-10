// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPageNavigationDownloads } from './use-browser-page-navigation-downloads'
import {
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'

const mocks = vi.hoisted(() => ({ notice: vi.fn(), target: vi.fn(), navigate: vi.fn() }))
vi.mock('@/lib/file-preview', () => ({
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE:
    'Open in Orca Browser is only available for local files.',
  getWorkspaceFileBrowserOpenTarget: mocks.target
}))
vi.mock('./navigate-browser-page-url', () => ({ navigateBrowserPageToUrl: mocks.navigate }))
vi.mock('./workspace-doc-address-submission', () => ({
  routeWorkspaceDocAddressSubmission: vi.fn()
}))
vi.mock('./use-browser-page-download-events', () => ({
  useBrowserPageDownloadEvents: () => ({ downloadStates: [], setDownloadStates: vi.fn() })
}))

function DropSurface() {
  const nav = useBrowserPageNavigationDownloads({
    browserTabId: 'page-local',
    worktreeId: 'global-floating-terminal',
    webviewRef: { current: null },
    activeLoadFailureRef: { current: null },
    lastKnownWebviewUrlRef: { current: null },
    trackNextLoadingEventRef: { current: false },
    recoveryNavigationValidationRef: { current: null },
    onSetUrlRef: { current: vi.fn() },
    onUpdatePageStateRef: { current: vi.fn() },
    keepAddressBarFocusRef: { current: false },
    focusWebviewNow: vi.fn(() => false),
    setResourceNotice: mocks.notice,
    addressBarValueRef: { current: 'about:blank' },
    addressBarInputRef: { current: null },
    browserTabUrl: 'about:blank'
  })
  return <div data-testid="drop" onDrop={(event) => nav.handleInternalFileDropRef.current(event)} />
}

function dropPayload(source: string | null) {
  const values = new Map([[WORKSPACE_FILE_PATH_MIME, '/same/path/report.html']])
  if (source !== null) {
    values.set(WORKSPACE_FILE_DRAG_SOURCE_MIME, source)
  }
  return { types: [...values.keys()], getData: (type: string) => values.get(type) ?? '' }
}

describe('browser file drops preserve source ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.target.mockReturnValue({ status: 'ready', url: 'file:///same/path/report.html' })
  })
  afterEach(cleanup)

  it.each(['runtime:host-a', 'ssh:host-a', 'runtime:unresolved-owner'])(
    'rejects a %s source before local URL resolution',
    (executionHostId) => {
      const view = render(<DropSurface />)
      fireEvent.drop(view.getByTestId('drop'), {
        dataTransfer: dropPayload(
          JSON.stringify({
            version: 1,
            executionHostId,
            workspaceId: 'source-workspace'
          })
        )
      })
      expect(mocks.target).not.toHaveBeenCalled()
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(mocks.notice).toHaveBeenCalledWith(
        'Open in Orca Browser is only available for local files.'
      )
    }
  )

  it.each([null, '{broken', '{"version":1,"executionHostId":"local"}'])(
    'rejects an unresolved source %s',
    (source) => {
      const view = render(<DropSurface />)
      fireEvent.drop(view.getByTestId('drop'), { dataTransfer: dropPayload(source) })
      expect(mocks.target).not.toHaveBeenCalled()
      expect(mocks.navigate).not.toHaveBeenCalled()
    }
  )

  it('accepts a desktop source from another workspace into the floating browser', () => {
    const view = render(<DropSurface />)
    fireEvent.drop(view.getByTestId('drop'), {
      dataTransfer: dropPayload(
        JSON.stringify({
          version: 1,
          executionHostId: 'local',
          workspaceId: 'source-workspace'
        })
      )
    })
    expect(mocks.target).toHaveBeenCalledWith({
      filePath: '/same/path/report.html',
      worktreeId: 'global-floating-terminal'
    })
    expect(mocks.notice).toHaveBeenCalledWith('Browser page is not ready for file drops.')
  })
})
