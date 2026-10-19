// Pins that a workspace a paired server owns never reaches main's `layout.apply`: its layout stays
// the server's, mirrored by the window, in a layout-owner build too.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

import { recordLayoutApply, sendLayoutApply, type WindowLayoutCommand } from './layout-apply-send'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import {
  adoptLiveTerminalThroughLayoutOwner,
  createInitialTerminalThroughLayoutOwner
} from '@/store/terminals/terminal-tab-create-through-layout-owner'

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
  { type: 'moveTab', tabId: 't', toGroupId: 'g', index: 0 },
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

  it('resolves to its server, so every guard below reads it as paired', () => {
    expect(runtimeEnvironmentIdUnlessTwin(rows, workspaceId)).toBe('env-b')
  })

  it.each(COMMANDS)('sendLayoutApply sends no $type', (command) => {
    const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn() }

    expect(sendLayoutApply(rows, workspaceId, command, handlers)).toBe(false)
    recordLayoutApply(rows, workspaceId, command)

    expect(layoutApplyCalls()).toEqual([])
    expect(handlers.apply).not.toHaveBeenCalled()
  })

  it('the activation terminal create sends nothing', () => {
    const create = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paired-server guard returns before anything but the owner rows is read.
    const getState = () => rows as AppState

    expect(createInitialTerminalThroughLayoutOwner(getState, workspaceId, create)).toBe(false)
    expect(layoutApplyCalls()).toEqual([])
  })

  it('the live terminal adoption sends nothing', async () => {
    await expect(
      adoptLiveTerminalThroughLayoutOwner(() => rows, workspaceId, { ptyId: 'pty-1' })
    ).resolves.toBe('as-today')
    expect(layoutApplyCalls()).toEqual([])
  })
})

/** Every renderer source file that names the `layout.apply` method, with its count. */
function layoutApplySenders(root: string): Record<string, number> {
  const found: Record<string, number> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry) || /\.(test|spec)\.tsx?$/.test(entry)) {
        continue
      }
      const count = readFileSync(full, 'utf8').split(`'layout.apply'`).length - 1
      if (count > 0) {
        found[path.relative(root, full).split(path.sep).join('/')] = count
      }
    }
  }
  walk(root)
  return found
}

describe('layout.apply senders', () => {
  // A new sender must go through sendLayoutApply or carry the same guard, plus a case above.
  it('are only the guarded paths pinned above', () => {
    expect(layoutApplySenders(path.resolve(__dirname, '..'))).toEqual({
      'runtime/layout-apply-send.ts': 1,
      'store/terminals/terminal-tab-create-through-layout-owner.ts': 2
    })
  })
})
