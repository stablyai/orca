import { vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import type { CliChatResumeTestMocks } from './cli-chat-resume-mocks.test-fixture'
import { LEAF_1, LEAF_2 } from '../terminal-pane/pty-connection-test-pane-fixtures'
import { captureTerminalSurfaceIdentity } from '../../../../shared/terminal-tab-close'
import { TerminalClose } from '../../../../shared/rpc-contract/terminal-unary-params'
import { retireTerminalPresentation } from '../terminal-pane/terminal-presentation-retirement'
import {
  capturedPanesByTabId,
  parkedWatchersByTabId
} from '../terminal-pane/terminal-parked-watcher-registry'

export function installExitedPaneRetirement(mocks: CliChatResumeTestMocks): {
  closed: Mock
  siblingWatcher: Mock
} {
  const closed = vi.fn()
  const siblingWatcher = vi.fn()
  capturedPanesByTabId.set('shell', {
    worktreeId: 'wt-1',
    panes: [
      { paneId: 1, leafId: LEAF_1, ptyId: 'pty-1', drivesTabTitle: false },
      { paneId: 2, leafId: LEAF_2, ptyId: 'pty-2', drivesTabTitle: true }
    ]
  })
  parkedWatchersByTabId.set('shell', {
    worktreeId: 'wt-1',
    tabPtyId: 'pty-2',
    paneIdByPtyId: new Map([
      ['pty-1', 1],
      ['pty-2', 2]
    ]),
    disposersByPtyId: new Map([
      ['pty-1', closed],
      ['pty-2', siblingWatcher]
    ])
  })
  mocks.rpc.mockImplementation(async (_target, method, params: unknown) => {
    if (method === 'terminal.resolvePane') {
      const identity = captureTerminalSurfaceIdentity(
        useAppStore.getState(),
        'wt-1',
        'shell',
        LEAF_1
      )
      if (!identity) {
        throw new Error('Missing original terminal')
      }
      return {
        terminal: {
          handle: 'handle-1',
          ptyId: 'pty-1',
          incarnationId: 'i1',
          presentation: { identity: { ...identity, incarnationId: 'i1' }, holders: [] }
        }
      }
    }
    if (method !== 'terminal.close') {
      throw new Error('Unexpected RPC')
    }
    const close = TerminalClose.parse(params)
    if (!close.originalPresentation) {
      throw new Error('Missing original presentation')
    }
    retireTerminalPresentation(close.originalPresentation.identity)
    return { close: { ptyKilled: true } }
  })
  return { closed, siblingWatcher }
}
