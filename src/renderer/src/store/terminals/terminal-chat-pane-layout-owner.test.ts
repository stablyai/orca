import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import { _resetLayoutOwnerPaneIntentsForTests } from '@/runtime/layout-owner-pane-intents'

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { LayoutApplyParams } from '../../../../shared/rpc-contract/workspace-layout-params'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import { layoutCommandsOf } from '@/runtime/layout-apply-test-double'
import type {
  LayoutTerminalTab,
  WorkspaceLayoutModel
} from '../../../../shared/workspace-layout/workspace-layout-model'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({
    ok: true,
    result: {}
  }))
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const LEAF = '11111111-1111-4111-8111-111111111111'

let store: ReturnType<typeof createTestStore>
/** Main's copy; it changes only through what the window sends. */
let main: WorkspaceLayoutModel

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  _resetLayoutOwnerPaneIntentsForTests()
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
})

/** Applies what the window sent to main's copy, as `layout.apply` does; any refusal fails. */
function applySent() {
  const commands = mocks.callRuntimeRpc.mock.calls.flatMap(([, , params]) =>
    layoutCommandsOf(LayoutApplyParams.parse(params).command)
  )
  mocks.callRuntimeRpc.mockClear()
  let id = 0
  for (const command of commands) {
    const applied = applyLayoutCommand(main, command, {
      mintId: () => `main-${++id}`,
      mintLeafId: () => `leaf-${++id}`,
      now: () => 1
    })
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    main = applied.model
  }
  return commands
}

function mainTab(tabId: string): LayoutTerminalTab {
  const tab = main.workspaces[WT]!.tabs.find((entry) => entry.id === tabId)
  if (tab?.kind !== 'terminal') {
    throw new Error('main holds no such terminal tab')
  }
  return tab
}

/** A one-pane tab main holds, as the window made it. */
function heldTab(): string {
  const tab = store.getState().createTab(WT, undefined, undefined, { initialLeafId: LEAF })
  applySent()
  return tab.id
}

function setChatLeaf(tabId: string, chatLeafId: string | null): void {
  const { chatLeafId: _old, ...layout } = store.getState().terminalLayoutsByTabId[tabId]!
  store.getState().setTabLayout(tabId, chatLeafId ? { ...layout, chatLeafId } : layout)
}

describe('the chat pane in a layout-owner build', () => {
  it('records each chat pane the window picks in main, so its save changes none', () => {
    const tabId = heldTab()

    setChatLeaf(tabId, LEAF)
    expect(applySent()).toEqual([{ type: 'setChatPane', workspace: WT, tabId, leafId: LEAF }])
    expect(mainTab(tabId).panes.chatLeafId).toBe(LEAF)

    setChatLeaf(tabId, null)
    applySent()
    expect(mainTab(tabId).panes.chatLeafId).toBeUndefined()
  })
})
