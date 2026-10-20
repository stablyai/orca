// Tab properties in a layout-owner build: main's pin, color or rename, drawn from its frame, must
// look as the window's own action does today, and must restart the same.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { testContext } from '../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  bootWindowFromPartitions,
  projectStartupWindowView
} from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import type { AppState } from '../store/types'
import { layoutApplyTestTransport } from './layout-apply-test-transport.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

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

type Store = ReturnType<typeof createTestStore>

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  check.uninstall()
  expect(check.failures).toEqual([])
})

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * What the user sees of the tabs: the startup view (order, groups, labels, titles, panes) plus each
 * tab's pin, preview and color. Record order in the slices and a row's own sortOrder are not shown.
 */
function shownTabs(state: AppState): Record<string, unknown> {
  const view = projectStartupWindowView(state)
  for (const [key, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      view[`${key} tab ${tab.id} props`] = {
        pinned: tab.isPinned === true,
        preview: tab.isPreview === true,
        color: tab.color ?? null
      }
    }
  }
  for (const [key, rows] of Object.entries(state.tabsByWorktree)) {
    for (const row of rows) {
      view[`${key} terminal ${row.id} props`] = {
        pinned: row.isPinned === true,
        color: row.color ?? null,
        customTitle: row.customTitle ?? null
      }
    }
  }
  return view
}

/** Main's `layout.apply` on the stored partition: load, apply, then write only touched records. */
function mainApplies(stored: WorkspaceSessionState, command: LayoutCommand): WorkspaceSessionState {
  const loaded = loadWorkspaceLayoutWithoutReport('local', stored, nameBasedLoadContext())
  const applied = applyLayoutCommand(loaded.layout, command, testContext())
  if (!applied.ok) {
    throw new Error(`main refused ${command.type}: ${applied.code}`)
  }
  return patchStoredSession(
    stored,
    saveWorkspaceLayout(loaded),
    saveWorkspaceLayout({ ...loaded, layout: applied.model })
  )
}

function frameOf(stored: WorkspaceSessionState): WorkspaceLayoutChangeFrame {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', stored, nameBasedLoadContext())
  return {
    type: 'workspace',
    key: GIT_KEY,
    layout: publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
  }
}

async function boot(session: WorkspaceSessionState): Promise<Store> {
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  return store
}

type Case = {
  name: string
  session?: () => WorkspaceSessionState
  /** What main receives (the tab bar's command, addressed by tab-bar id). */
  command: LayoutCommand
  /** The window's own action today, as the tab bar runs it. */
  windowAction: (state: AppState) => void
  /** Where main's result differs from today's, by `shownTabs` path: main's value. */
  mainShows?: Record<string, unknown>
  /** What main's copy shows until the window's own action runs and the window saves it. */
  mainCopyLags?: Record<string, unknown>
}

const CASES: Case[] = [
  {
    name: 'rename a terminal',
    command: {
      type: 'renameTab',
      workspace: GIT_KEY,
      tabId: 'tab-shell',
      kind: 'custom',
      title: 'Build'
    },
    windowAction: (state) => state.setTabCustomTitle('tab-shell', 'Build')
  },
  {
    name: 'clear the title of a terminal whose tab-bar id differs from its terminal’s',
    command: {
      type: 'renameTab',
      workspace: GIT_KEY,
      tabId: 'tab-agent',
      kind: 'custom',
      title: null
    },
    windowAction: (state) => state.setTabCustomTitle('term-agent', null),
    // Today a terminal with no live title yet keeps showing the cleared title until one arrives.
    mainShows: { [`${GIT_KEY} terminal term-agent phone and CLI title`]: 'Terminal 2' }
  },
  {
    name: 'rename a chat',
    command: {
      type: 'renameTab',
      workspace: GIT_KEY,
      tabId: 'agent-session-1',
      kind: 'custom',
      title: 'Review'
    },
    windowAction: (state) => state.setTabCustomTitle('agent-session-1', 'Review')
  },
  {
    name: 'color a terminal',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'tab-shell', color: '#22c55e' },
    windowAction: (state) => state.setTabColor('tab-shell', '#22c55e')
  },
  {
    name: 'clear a color',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'tab-agent', color: null },
    windowAction: (state) => state.setTabColor('term-agent', null)
  },
  {
    name: 'pin a terminal behind the pinned one',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'tab-shell', isPinned: true },
    windowAction: (state) => state.pinTab('tab-shell')
  },
  {
    name: 'pin the last tab of the second group',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'tab-unbound', isPinned: true },
    windowAction: (state) => state.pinTab('tab-unbound')
  },
  {
    name: 'unpin',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'tab-agent', isPinned: false },
    windowAction: (state) => state.unpinTab('tab-agent'),
    // Today's unpin skips the row of a terminal whose id differs from its tab's; main reads the row.
    mainShows: {
      [`${GIT_KEY} terminal term-agent props`]: {
        pinned: false,
        color: '#7c3aed',
        customTitle: 'Agent'
      }
    }
  },
  {
    name: 'pin a browser tab',
    command: { type: 'setTabProps', workspace: GIT_KEY, tabId: 'browser-1', isPinned: true },
    windowAction: (state) => state.pinTab('browser-1')
  },
  {
    name: 'pin a preview file, which keeps it',
    session: () => {
      const session = localDesktopSession()
      session.unifiedTabs![GIT_KEY] = session.unifiedTabs![GIT_KEY]!.map((tab) =>
        tab.contentType === 'editor' ? { ...tab, isPreview: true } : tab
      )
      session.openFilesByWorktree![GIT_KEY] = session.openFilesByWorktree![GIT_KEY]!.map(
        (file) => ({ ...file, isPreview: true })
      )
      return session
    },
    command: {
      type: 'setTabProps',
      workspace: GIT_KEY,
      tabId: 'editor:src/app.ts',
      isPinned: true
    },
    windowAction: (state) => state.pinFile('/Users/dev/orca/src/app.ts', 'editor:src/app.ts'),
    // Preview stays the window's until main opens files (phase C4).
    mainCopyLags: {
      [`${GIT_KEY} tab editor:src/app.ts props`]: { pinned: true, preview: true, color: null }
    }
  }
]

describe('tab properties through main', () => {
  it.each(CASES.map((entry) => [entry.name, entry] as const))(
    '%s: main’s frame shows what the window’s own action shows, and restarts the same',
    async (_, entry) => {
      const stored = (entry.session ?? localDesktopSession)()

      // Today: the window acts on its own copy.
      const today = await boot(stored)
      entry.windowAction(today.getState())
      await layoutApplyTestTransport.settle()
      const todayTabs = shownTabs(today.getState())
      expect(todayTabs).not.toEqual(shownTabs((await boot(stored)).getState()))
      const expected = { ...todayTabs, ...entry.mainShows }

      // Layout-owner build: main applies first and the window draws main's frame.
      const afterMain = mainApplies(stored, entry.command)
      const drawn = await boot(stored)
      const sync = openWorkspaceLayoutFrameSync(drawn)
      stream.onFrame!({ type: 'snapshot', workspaces: [] })
      sync.start()
      stream.onFrame!(frameOf(afterMain))
      await flushMicrotasks()
      const mainCopy = { ...expected, ...entry.mainCopyLags }
      expect(shownTabs(drawn.getState())).toEqual(mainCopy)

      // Main's answer then runs the window's own action, which leaves what today's action shows.
      entry.windowAction(drawn.getState())
      await layoutApplyTestTransport.settle()
      expect(shownTabs(drawn.getState())).toEqual(expected)
      sync.close()

      // A restart from main's write alone shows main's copy.
      expect(shownTabs((await boot(afterMain)).getState())).toEqual(mainCopy)
    }
  )
})
