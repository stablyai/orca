// Paired-owned workspace layouts stay on their server; even layout-owner builds must never send them to local main.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import {
  recordLayoutApply,
  sendLayoutApply,
  sendToServerMain,
  type WindowLayoutCommand
} from './layout-apply-send'
import { createInitialTerminalThroughLayoutOwner } from '@/store/terminals/terminal-tab-create-through-layout-owner'

const WORKTREE_ID = 'repo-1::/srv/w'
const FOLDER_ID = 'folder:f1'

const PAIRED_WORKSPACES: {
  name: string
  workspaceId: string
  rows: WorktreeOperationRouteState
}[] = [
  {
    name: 'a worktree on a paired server',
    workspaceId: WORKTREE_ID,
    rows: {
      repos: [{ id: 'repo-1', executionHostId: 'runtime:env-b' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: WORKTREE_ID,
            repoId: 'repo-1',
            hostId: 'runtime:env-b',
            runtimeOwnerEnvironmentId: 'env-b'
          }
        ]
      }
    }
  },
  {
    name: 'a folder workspace on a paired server',
    workspaceId: FOLDER_ID,
    rows: {
      folderWorkspaces: [
        {
          id: 'f1',
          projectGroupId: 'g1',
          connectionId: null,
          executionHostId: 'runtime:env-b',
          diffComments: []
        }
      ]
    }
  }
]

const COMMANDS: WindowLayoutCommand[] = [
  { type: 'splitPane', tabId: 't', leafId: 'l', direction: 'vertical', newLeafId: 'l2' },
  { type: 'closePane', tabId: 't', leafId: 'l' },
  { type: 'closeTabs', tabIds: ['t'] },
  { type: 'renameTab', tabId: 't', kind: 'custom', title: 'x' },
  // An anchored move too, so no server, old or new, is sent the anchor.
  { type: 'moveTab', tabId: 't', toGroupId: 'g', index: 0, afterTabId: 's' },
  { type: 'createTerminalTab', tabId: 't', leafId: 'l' },
  { type: 'sleep', tabId: 't', paneKeys: ['t:l'], records: [] },
  { type: 'setDefaultTabsApplied' }
]

function layoutApplyCalls(): unknown[][] {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'layout.apply')
}

describe.each(PAIRED_WORKSPACES)('$name', ({ workspaceId, rows }) => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
  })

  it.each(COMMANDS)('sendLayoutApply sends no $type', (command) => {
    const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }

    expect(sendLayoutApply(rows, workspaceId, command, handlers)).toBe(false)
    recordLayoutApply(rows, workspaceId, command)

    expect(layoutApplyCalls()).toEqual([])
    expect(handlers.apply).not.toHaveBeenCalled()
  })

  it('an editor hand-over reaches that server’s main, never this window’s', () => {
    mocks.callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    sendToServerMain(
      'env-b',
      workspaceId,
      { type: 'openEditorTab', tabId: 't', fileId: 'f', contentType: 'editor' },
      vi.fn()
    )

    expect(layoutApplyCalls().map((call) => call[0])).toEqual([
      { kind: 'environment', environmentId: 'env-b' }
    ])
  })

  it('the activation terminal create sends nothing', () => {
    const create = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paired-server guard returns before anything but the owner rows is read.
    const getState = () => rows as AppState

    expect(createInitialTerminalThroughLayoutOwner(getState, workspaceId, create)).toBe(false)
    expect(layoutApplyCalls()).toEqual([])
  })
})
