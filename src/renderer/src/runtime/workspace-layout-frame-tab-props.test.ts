// Main’s frame-drawn pin/color/rename must match current window actions and survive restart in layout-owner builds.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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
import { withLayoutOwnerTabProps } from '../components/tab-bar/tab-bar-layout-owner-props'
import { useAppStore } from '@/store'
import type { AppState } from '../store/types'
import { layoutApplyTestTransport } from './layout-apply-test-transport.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'

// Today's window acts with the switch off; the layout-owner window, with it on.
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

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

/** Compare visible startup view plus pin/preview/color; slice order and row sortOrder are not visible. */
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

const APP_FILE = '/Users/dev/orca/src/app.ts'
const PIN_PREVIEW: LayoutCommand = {
  type: 'setTabProps',
  workspace: GIT_KEY,
  tabId: 'editor:src/app.ts',
  isPinned: true
}

/** The profile with its editor tab a preview. */
function previewSession(): WorkspaceSessionState {
  const session = localDesktopSession()
  session.unifiedTabs![GIT_KEY] = session.unifiedTabs![GIT_KEY]!.map((tab) =>
    tab.contentType === 'editor' ? { ...tab, isPreview: true } : tab
  )
  session.openFilesByWorktree![GIT_KEY] = session.openFilesByWorktree![GIT_KEY]!.map((file) => ({
    ...file,
    isPreview: true
  }))
  return session
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
    session: previewSession,
    command: PIN_PREVIEW,
    windowAction: (state) => state.pinFile(APP_FILE, 'editor:src/app.ts'),
    // Main's copy keeps the preview until the window's keep reaches main.
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
      layoutOwner.isMain = false
      const today = await boot(stored)
      entry.windowAction(today.getState())
      await layoutApplyTestTransport.settle()
      const todayTabs = shownTabs(today.getState())
      expect(todayTabs).not.toEqual(shownTabs((await boot(stored)).getState()))
      const expected = { ...todayTabs, ...entry.mainShows }

      // Layout-owner build: main applies first and the window draws main's frame.
      layoutOwner.isMain = true
      const afterMain = mainApplies(stored, entry.command)
      const drawn = await boot(stored)
      const sync = openWorkspaceLayoutFrameSync(drawn)
      stream.onFrame!({ type: 'snapshot', workspaces: [] })
      sync.start()
      stream.onFrame!(frameOf(afterMain))
      await flushMicrotasks()
      const mainCopy = { ...expected, ...entry.mainCopyLags }
      expect(shownTabs(drawn.getState())).toEqual(mainCopy)

      // Frame already drew the command result; answer changes only window-owned preview state for parity with current actions.
      entry.windowAction(drawn.getState())
      await layoutApplyTestTransport.settle()
      // A preview's end goes to main as well; its frame draws it.
      const promotes = layoutApplyTestTransport.sentOfType('promotePreviewTab')
      if (promotes.length > 0) {
        stream.onFrame!(frameOf(promotes.reduce(mainApplies, afterMain)))
        await flushMicrotasks()
      }
      expect(shownTabs(drawn.getState())).toEqual(expected)
      sync.close()

      // A restart from main's write alone shows main's copy.
      expect(shownTabs((await boot(afterMain)).getState())).toEqual(mainCopy)
    }
  )
})

describe('the tab bar’s pin through main', () => {
  it('pins a preview file as today’s pin does: main’s frame, the window’s preview end, and a use', async () => {
    const stored = previewSession()
    layoutOwner.isMain = false
    const today = await boot(stored)
    today.getState().pinFile(APP_FILE, 'editor:src/app.ts')
    const expected = shownTabs(today.getState())

    layoutOwner.isMain = true
    const recordFeatureInteraction = vi.fn()
    const previousRecord = useAppStore.getState().recordFeatureInteraction
    useAppStore.setState({ recordFeatureInteraction })
    onTestFinished(() => useAppStore.setState({ recordFeatureInteraction: previousRecord }))
    layoutApplyTestTransport.reset()
    const drawn = await boot(stored)
    const sync = openWorkspaceLayoutFrameSync(drawn)
    stream.onFrame!({ type: 'snapshot', workspaces: [] })
    sync.start()
    const windowPin = vi.fn()
    withLayoutOwnerTabProps(
      {
        togglePinned: windowPin,
        makePreviewFilePermanent: (fileId, tabId) =>
          drawn.getState().makePreviewFilePermanent(fileId, tabId)
      },
      () => GIT_KEY
    ).togglePinned({
      unifiedTabId: 'editor:src/app.ts',
      isPinned: false,
      type: 'editor',
      data: { id: APP_FILE }
    })
    // Main's frame arrives before its answer.
    const pinned = mainApplies(stored, PIN_PREVIEW)
    stream.onFrame!(frameOf(pinned))
    await layoutApplyTestTransport.settle()
    await flushMicrotasks()

    // The answer ends the preview, which the window's store action sends to main as well.
    const promote: LayoutCommand = {
      type: 'promotePreviewTab',
      workspace: GIT_KEY,
      tabId: 'editor:src/app.ts'
    }
    expect(layoutApplyTestTransport.sent).toEqual([PIN_PREVIEW, promote])
    stream.onFrame!(frameOf(mainApplies(pinned, promote)))
    await layoutApplyTestTransport.settle()
    await flushMicrotasks()
    expect(windowPin).not.toHaveBeenCalled()
    expect(recordFeatureInteraction).toHaveBeenCalledWith('terminal-tabs')
    expect(shownTabs(drawn.getState())).toEqual(expected)
    sync.close()
  })
})
