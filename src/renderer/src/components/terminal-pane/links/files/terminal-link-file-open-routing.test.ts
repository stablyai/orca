import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { handleOscLink } from '../terminal-osc-link-routing'
import { describe, expect, it, vi } from 'vitest'
import './terminal-link-handlers'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openFileMock, openFilePathMock, setPendingEditorRevealMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/lib/files/access/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('reports an unsupported floating directory instead of silently consuming the click', async () => {
    doubles.statMock.mockResolvedValueOnce({ isDirectory: true })
    const onOpenFailure = vi.fn()
    openDetectedFilePath('/tmp/folder', null, null, {
      ...deps,
      floatingWorkspace: true,
      onOpenFailure
    })
    await flushAsyncWork()
    expect(onOpenFailure).toHaveBeenCalledWith({ verdict: 'unavailable', error: expect.any(Error) })
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('places a file in floating while retaining its source owner and line target', async () => {
    setPlatform('Linux')
    openDetectedFilePath('/tmp/src/report.md', 12, 3, { ...deps, floatingWorkspace: true })
    await flushAsyncWork()
    await flushDoubleRaf()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/report.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null
      }),
      expect.objectContaining({
        placementWorkspaceId: 'global-floating-terminal',
        executionHostId: 'local',
        preview: false
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/report.md',
        line: 12,
        column: 3,
        viewStateId: 'view:/tmp/src/report.md'
      })
    )
  })

  it('opens an HTML file as a floating document rather than routing it as a website', async () => {
    setPlatform('Linux')
    openDetectedFilePath('/tmp/report.html', null, null, { ...deps, floatingWorkspace: true })
    await flushDoubleRaf()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/report.html', mode: 'edit' }),
      expect.objectContaining({ placementWorkspaceId: 'global-floating-terminal' })
    )
    expect(doubles.createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens an OSC8 file chord once with its line and column in floating', async () => {
    setPlatform('Macintosh')
    let prevented = false
    const event = {
      metaKey: true,
      ctrlKey: false,
      altKey: true,
      button: 0,
      get defaultPrevented() {
        return prevented
      },
      preventDefault: () => {
        prevented = true
      }
    }
    const context = {
      paneId: 1,
      pointerGesture: { canRequestAction: () => true, dispose: () => {} },
      claimPtyMouse: () => true,
      request: vi.fn(),
      focusTerminal: vi.fn()
    }
    expect(
      handleOscLink('file:///tmp/report.md#L9C4', event, { ...deps, linkActionContext: context })
    ).toBe(true)
    expect(
      handleOscLink('file:///tmp/report.md#L9C4', event, { ...deps, linkActionContext: context })
    ).toBe(false)
    await flushAsyncWork()
    await flushDoubleRaf()
    expect(openFileMock.mock.calls).toEqual([
      [
        expect.objectContaining({ filePath: '/tmp/report.md' }),
        expect.objectContaining({ placementWorkspaceId: 'global-floating-terminal' })
      ]
    ])
    expect(setPendingEditorRevealMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/report.md', line: 9, column: 4 })
    )
  })

  it('retains a folder workspace file owner when opening its floating document', async () => {
    setPlatform('Linux')
    storeState.folderWorkspaces = [
      makeFolderWorkspace({ id: 'folder-notes', folderPath: '/tmp', executionHostId: 'local' })
    ]
    openDetectedFilePath('/tmp/report.md', null, null, {
      worktreeId: 'folder-notes',
      worktreePath: '/tmp',
      floatingWorkspace: true
    })
    await flushAsyncWork()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'folder-notes', filePath: '/tmp/report.md' }),
      expect.objectContaining({ placementWorkspaceId: 'global-floating-terminal' })
    )
  })
})
