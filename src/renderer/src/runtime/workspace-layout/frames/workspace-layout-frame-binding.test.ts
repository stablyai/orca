import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  GIT_KEY,
  leaf
} from '../../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import { endLayoutFramePositions } from './layout-frame-position'
import { holdTabPaneTree } from '../intents/layout-owner-pane-tree-holds'
import '../intents/layout-owner-drawn-tab-holds'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'
import { installLayoutFrameApplyCheck } from '../testing/workspace-layout-frame-apply-check.test-fixture'
import { mainLayoutFrameSender } from '../testing/main-loaded-layout-frames.test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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

function publishedOf(session: WorkspaceSessionState): PublishedWorkspaceLayout {
  const { layout } = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext())
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, 'local')
}

/** The frame with one pane's terminal binding changed; absent `ptyId` unbinds it. */
function rebound(
  layout: PublishedWorkspaceLayout,
  tabId: string,
  leafId: string,
  ptyId: string | undefined
): PublishedWorkspaceLayout {
  const next = structuredClone(layout)
  const pane = next.tabs
    .find((tab) => tab.entityId === tabId)!
    .terminal!.panes.find((candidate) => candidate.leafId === leafId)!
  if (ptyId === undefined) {
    delete pane.ptyId
  } else {
    pane.ptyId = ptyId
  }
  return next
}

/** Boots a window shown from the session's frame; each later frame arrives as main sends it. */
async function boot() {
  const store = createTestStore()
  const session = localDesktopSession()
  await bootWindowFromPartitions(store, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(store)
  const first = publishedOf(session)
  const frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot({ [GIT_KEY]: first }))
  sync.start()
  await settle()
  check.forgetBuilds()
  const send = async (layout: PublishedWorkspaceLayout, asSnapshot = false): Promise<void> => {
    stream.onFrame!(
      asSnapshot ? frames.snapshot({ [GIT_KEY]: layout }) : frames.records(GIT_KEY, layout)
    )
    await settle()
  }
  return { store, sync, first, send }
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a frame that changes only panes’ terminal bindings', () => {
  it('keeps a tab the window’s own pane command holds as the store has it, then shows its binding', async () => {
    const { store, sync, first, send } = await boot()
    const before = store.getState().terminalLayoutsByTabId['tab-shell']
    const release = holdTabPaneTree('tab-shell')

    await send(rebound(first, 'tab-shell', leaf(1), 'pty-fresh'))

    expect(store.getState().terminalLayoutsByTabId['tab-shell']).toBe(before)
    release()
    await settle()
    // Released, the tab shows the binding main wrote meanwhile.
    expect(store.getState().terminalLayoutsByTabId['tab-shell']!.ptyIdsByLeafId?.[leaf(1)]).toBe(
      'pty-fresh'
    )
    sync.close()
  })
})
