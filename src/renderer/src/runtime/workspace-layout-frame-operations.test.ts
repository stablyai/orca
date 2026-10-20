// Main's operations as the window draws them from their records frames (design E2a): each shows
// from the store's own view, without reading the window's session back, and leaves the store as
// the full build does (the apply check, installed below).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { testContext } from '../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { endLayoutFramePositions } from './layout-frame-position'
import {
  loadMainLayoutModel,
  mainLayoutFrameSender,
  publishedLayoutsOf
} from './main-loaded-layout-frames.test-fixture'
import {
  installLayoutFrameApplyCheck,
  layoutFrameApplyErrors
} from './workspace-layout-frame-apply-check.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const SHELL_LEAF = '11111111-1111-4111-8111-111111111111'

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

/** A window shown from main's snapshot; `apply` runs a command on main's model and sends its frame. */
async function boot() {
  const session = localDesktopSession()
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  let model: WorkspaceLayoutModel = loadMainLayoutModel('local', session)
  const context = testContext()
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot(publishedLayoutsOf(model)))
  sync.start()
  await settle()
  check.forgetBuilds()
  const apply = async (...commands: LayoutCommand[]): Promise<void> => {
    for (const command of commands) {
      const applied = applyLayoutCommand(model, command, context)
      if (!applied.ok) {
        throw new Error(`main refused ${command.type}: ${applied.code}`)
      }
      model = applied.model
      stream.onFrame!(frames.records(GIT_KEY, publishedLayoutsOf(model)[GIT_KEY]!))
    }
    await settle()
  }
  return { store, apply, close: () => sync.close() }
}

const on = { workspace: GIT_KEY }

describe('main’s operations drawn record by record', () => {
  it.each<[string, LayoutCommand[]]>([
    ['a rename', [{ ...on, type: 'renameTab', tabId: 'tab-shell', kind: 'custom', title: 'api' }]],
    ['a color and a pin', [{ ...on, type: 'setTabProps', tabId: 'tab-unbound', color: '#22c55e' }]],
    [
      'a split',
      [{ ...on, type: 'splitPane', tabId: 'tab-shell', leafId: SHELL_LEAF, direction: 'vertical' }]
    ],
    ['a pane close', [{ ...on, type: 'closePane', tabId: 'tab-shell', leafId: SHELL_LEAF }]],
    ['a tab close', [{ ...on, type: 'closeTabs', tabIds: ['tab-unbound'] }]],
    ['a move', [{ ...on, type: 'moveTab', tabId: 'tab-unbound', toGroupId: 'group-a', index: 0 }]],
    [
      'a group change',
      [
        {
          ...on,
          type: 'splitGroup',
          tabId: 'tab-unbound',
          besideGroupId: 'group-b',
          direction: 'down'
        }
      ]
    ],
    ['a new terminal', [{ ...on, type: 'createTerminalTab', groupId: 'group-b', title: 'new' }]],
    [
      'an editor open',
      [
        {
          ...on,
          type: 'openEditorTab',
          fileId: '/Users/dev/orca/src/main.ts',
          contentType: 'editor',
          file: {
            filePath: '/Users/dev/orca/src/main.ts',
            relativePath: 'src/main.ts',
            language: 'typescript'
          },
          groupId: 'group-a'
        }
      ]
    ]
  ])('shows %s without the full build', async (_, commands) => {
    const { store, apply, close } = await boot()
    const before = store.getState()

    await apply(...commands)

    expect(check.fullBuilt).toEqual([])
    expect(check.workspaceBuilt).toEqual([GIT_KEY])
    // Presence: the frame changed what the store shows.
    expect(store.getState()).not.toBe(before)
    close()
  })
})

type Store = Awaited<ReturnType<typeof boot>>['store']

const groupsOf = (store: Store) => store.getState().groupsByWorktree[GIT_KEY]!

describe('a frame over view state the save trims', () => {
  it.each<[string, (store: Store) => void]>([
    [
      'a focused diff tab, which the save does not keep',
      (store) => {
        const file = store.getState().openFiles.find((open) => open.worktreeId === GIT_KEY)!
        const diff = { ...file, id: `${file.id}::diff`, mode: 'diff' as const }
        store.setState({
          openFiles: [...store.getState().openFiles, diff],
          activeFileIdByWorktree: {
            ...store.getState().activeFileIdByWorktree,
            [GIT_KEY]: diff.id
          },
          activeTabTypeByWorktree: {
            ...store.getState().activeTabTypeByWorktree,
            [GIT_KEY]: 'editor'
          }
        })
      }
    ],
    [
      'a group whose shown tab is gone',
      (store) =>
        store.setState({
          groupsByWorktree: {
            [GIT_KEY]: groupsOf(store).map((group, index) =>
              index === 0 ? { ...group, activeTabId: 'gone' } : group
            )
          }
        })
    ],
    [
      'an empty group, active',
      (store) =>
        store.setState({
          groupsByWorktree: {
            [GIT_KEY]: [
              ...groupsOf(store),
              { id: 'group-empty', worktreeId: GIT_KEY, activeTabId: null, tabOrder: [] }
            ]
          },
          activeGroupIdByWorktree: { [GIT_KEY]: 'group-empty' }
        })
    ],
    [
      'a group id twice, where the Loader keeps the first',
      (store) =>
        store.setState({
          groupsByWorktree: {
            [GIT_KEY]: [...groupsOf(store), { ...groupsOf(store)[0]!, activeTabId: 'tab-shell' }]
          }
        })
    ]
  ])('shows a rename over %s as the full build does', async (_, drawState) => {
    const { store, apply, close } = await boot()
    drawState(store)

    await apply({ ...on, type: 'renameTab', tabId: 'tab-shell', kind: 'custom', title: 'api' })

    expect(check.fullBuilt).toEqual([])
    expect(check.workspaceBuilt).toEqual([GIT_KEY])
    close()
  })
})

describe('the apply check on a flush that built one workspace in full', () => {
  it('still checks the workspace built from the store view', async () => {
    const { store, close } = await boot()
    const shown = store.getState()
    const cache = publishedLayoutsOf(loadMainLayoutModel('local', localDesktopSession()))
    const observe = (after: typeof shown) =>
      layoutFrameApplyErrors({
        before: shown,
        after,
        cache,
        changed: [GIT_KEY, 'repo-other::/elsewhere'],
        fullBuilt: ['repo-other::/elsewhere'],
        workspaceBuilt: [GIT_KEY],
        rowFieldsTaken: new Map()
      })
    // Precondition: the store as booted is what the full build shows.
    expect(observe(shown)).toEqual([])

    const wrong = {
      ...shown,
      unifiedTabsByWorktree: {
        ...shown.unifiedTabsByWorktree,
        [GIT_KEY]: shown.unifiedTabsByWorktree[GIT_KEY]!.map((tab) => ({
          ...tab,
          customTitle: 'drawn wrong'
        }))
      }
    }
    expect(observe(wrong)).toEqual([expect.stringContaining('unifiedTabsByWorktree')])
    close()
  })
})
