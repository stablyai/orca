import { describe, expect, it, vi } from 'vitest'
import './terminal-link-handlers'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { handleTerminalFileLink } from './terminal-file-link-actions'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  deps,
  openFileMock,
  openFileForLinkMock,
  openFilePathMock,
  setPendingEditorRevealMock,
  statMock
} = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('ignores stale async completion so latest local click wins for Orca open and reveal', async () => {
    setPlatform('Macintosh')
    const firstStat = createDeferred<{ isDirectory: boolean }>()
    const secondStat = createDeferred<{ isDirectory: boolean }>()
    statMock
      .mockImplementationOnce(() => firstStat.promise)
      .mockImplementationOnce(() => secondStat.promise)

    openDetectedFilePath('/tmp/src/first.ts', 10, 2, deps)
    openDetectedFilePath('/tmp/src/second.ts', 20, 3, deps)

    secondStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    await flushDoubleRaf()

    firstStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/second.ts' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: '/tmp/src/second.ts',
        fileId: '/tmp/src/second.ts',
        line: 20,
        column: 3,
        matchLength: 0
      })
    )
  })
})

describe('handleTerminalFileLink', () => {
  it('opens a local file in the Floating Workspace on Cmd+Alt+click', async () => {
    setPlatform('Macintosh')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the node test env has no MouseEvent; the link path reads only these fields.
    const event = {
      button: 0,
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
      preventDefault: vi.fn()
    } as unknown as MouseEvent

    expect(handleTerminalFileLink('/tmp/src/report.ts', null, null, event, deps)).toBe(true)
    await flushAsyncWork()

    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/report.ts',
        worktreeId: 'global-floating-terminal',
        runtimeEnvironmentId: null
      }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })
})
