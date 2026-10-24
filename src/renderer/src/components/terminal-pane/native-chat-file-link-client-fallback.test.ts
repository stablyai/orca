import { describe, expect, it, vi } from 'vitest'
import { resolveNativeChatFileLink } from '../native-chat/native-chat-file-link'
import { nativeChatFileOpenDeps } from '../native-chat/native-chat-link-target-actions'
import { createNativeChatFileHref } from '../../../../shared/native-chat-href-routing'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, statMock, openFileMock, runtimeEnvironmentCallMock } = doubles

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

installTerminalLinkTestEnvironment(doubles)

const path = '/Users/me/notes.md'
const context = {
  worktreeId: 'wt-feat',
  worktreePath: '/srv/repo',
  runtimeEnvironmentId: 'env-1',
  nativeChatContext: { tabId: 'chat-tab', sessionId: 'chat-session' }
}

describe('post-session chat links to a file the paired host disowns', () => {
  it.each([
    [path, false],
    [`file://${path}`, false],
    [`sandbox:${path}`, true],
    [createNativeChatFileHref(path, 'sandbox'), true]
  ] as const)('%s keeps its source policy', async (href, hostOnly) => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-feat',
        relativePath: null,
        absolutePath: path,
        exists: false,
        isDirectory: false
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const target = resolveNativeChatFileLink(href, context)
    if (!target) {
      throw new Error('Expected a rendered file link target')
    }
    const onOpenFailure = vi.fn()
    openDetectedFilePath(target.absolutePath, target.line, target.column, {
      ...nativeChatFileOpenDeps(target, context),
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.resolveTerminalPath',
        params: expect.objectContaining({ nativeChatContext: context.nativeChatContext })
      })
    )
    if (hostOnly) {
      expect(statMock).not.toHaveBeenCalled()
      expect(openFileMock).not.toHaveBeenCalled()
      expect(onOpenFailure).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: 'unverifiable' })
      )
    } else {
      expect(onOpenFailure).not.toHaveBeenCalled()
      expect(statMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: path, access: { kind: 'user-file' } })
      )
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: path, runtimeEnvironmentId: null, readOnly: true }),
        { forceContentReload: true }
      )
    }
  })
})
