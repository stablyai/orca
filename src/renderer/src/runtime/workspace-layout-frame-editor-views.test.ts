// A diff tab main holds, drawn by a window that lacks its open file: the frame's view rebuilds it,
// both from a records frame and from the snapshot a reloaded window starts with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { LayoutEditorView } from '../../../shared/workspace-layout/layout-editor-view'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { testContext } from '../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { openFileOfLayoutEditorView } from '../store/slices/editor/tabs/open-file-layout-view'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { endLayoutFramePositions } from './layout-frame-position'
import {
  loadMainLayoutModel,
  mainLayoutFrameSender,
  publishedLayoutsOf
} from './main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
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

const DIFF_ID = `${GIT_KEY}::diff::unstaged::src/app.ts`
const VIEW: LayoutEditorView = {
  view: { mode: 'diff', diffSource: 'unstaged' },
  file: {
    filePath: '/Users/dev/orca/src/app.ts',
    relativePath: 'src/app.ts',
    language: 'typescript'
  }
}

const openDiff = (view?: LayoutEditorView): CommandOf<'openEditorTab'> => ({
  type: 'openEditorTab',
  workspace: GIT_KEY,
  tabId: DIFF_ID,
  fileId: DIFF_ID,
  contentType: 'diff',
  groupId: 'group-a',
  ...(view ? { view } : {})
})

function applied(model: WorkspaceLayoutModel, command: CommandOf<'openEditorTab'>) {
  const result = applyLayoutCommand(model, command, testContext())
  if (!result.ok) {
    throw new Error(`main refused ${command.type}: ${result.code}`)
  }
  return result.model
}

/** A window restored from its own session, shown from main's snapshot of `model`. */
async function boot(model = loadMainLayoutModel('local', localDesktopSession())) {
  const store = createTestStore()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session: localDesktopSession() }])
  // Precondition: the window's restore holds no diff, as after a reload.
  expect(store.getState().openFiles.some((file) => file.id === DIFF_ID)).toBe(false)
  const sync = openWorkspaceLayoutFrameSync(store)
  const frames = mainLayoutFrameSender()
  let shown = model
  stream.onFrame!(frames.snapshot(publishedLayoutsOf(shown)))
  sync.start()
  await settle()
  const apply = async (command: CommandOf<'openEditorTab'>): Promise<void> => {
    shown = applied(shown, command)
    stream.onFrame!(frames.records(GIT_KEY, publishedLayoutsOf(shown)[GIT_KEY]!))
    await settle()
  }
  return { store, apply, close: () => sync.close() }
}

const diffTabs = (store: Awaited<ReturnType<typeof boot>>['store']) =>
  (store.getState().unifiedTabsByWorktree[GIT_KEY] ?? []).filter((tab) => tab.entityId === DIFF_ID)

const REBUILT = openFileOfLayoutEditorView(VIEW, { entityId: DIFF_ID, worktreeId: GIT_KEY })

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a diff tab main publishes with its view', () => {
  it('draws from a records frame and rebuilds the open file the window lacks', async () => {
    const { store, apply, close } = await boot()
    check.forgetBuilds()

    await apply(openDiff(VIEW))

    expect(check.fullBuilt).toEqual([])
    expect(check.workspaceBuilt).toEqual([GIT_KEY])
    expect(diffTabs(store)).toHaveLength(1)
    expect(store.getState().openFiles.filter((file) => file.id === DIFF_ID)).toEqual([REBUILT])
    close()
  })

  it('is not drawn without a view, since the window cannot rebuild it', async () => {
    const { store, apply, close } = await boot()

    await apply(openDiff())

    expect(diffTabs(store)).toEqual([])
    expect(store.getState().openFiles.some((file) => file.id === DIFF_ID)).toBe(false)
    close()
  })

  it('shows after a reload, from the snapshot alone', async () => {
    const main = applied(loadMainLayoutModel('local', localDesktopSession()), openDiff(VIEW))

    const { store, close } = await boot(main)

    expect(check.fullBuilt).toContain(GIT_KEY)
    expect(diffTabs(store)).toHaveLength(1)
    expect(store.getState().groupsByWorktree[GIT_KEY]![0]!.tabOrder).toContain(DIFF_ID)
    expect(store.getState().openFiles.filter((file) => file.id === DIFF_ID)).toEqual([REBUILT])
    close()
  })
})
