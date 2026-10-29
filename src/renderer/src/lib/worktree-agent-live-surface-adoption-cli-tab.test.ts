/** CLI terminals can look unowned before mount; layout-owner main places/names them, and every finder must show that one tab without asking another adoption. */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { provideLayoutFrameTerminalPanes } from '../runtime/layout-frame-terminal-panes'
import {
  openWorkspaceLayoutFrameSync,
  type WorkspaceLayoutFrameSync
} from '../runtime/workspace-layout-frame-sync'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { adoptLiveWorkspacePtySurfaces } from './worktree-agent-live-surface-adoption'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'
import type { LiveTerminalSurfaceOwnerIndex } from './worktree-live-terminal-surface-owners'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onStatus: ((status: { state: string }) => void) | null
}
const stream = vi.hoisted((): StreamDouble => ({ onFrame: null, onStatus: null }))
vi.mock('../runtime/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    onStatus: (status: { state: string }) => void
  ) => {
    stream.onFrame = onFrame
    stream.onStatus = onStatus
    return { close: () => {} }
  }
}))

/** Main: applies the window's layout commands to its own model, publishing when the stream is up. */
const main = vi.hoisted((): { apply: ((command: LayoutCommand) => unknown) | null } => ({
  apply: null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: { command: LayoutCommand }) => {
    if (method !== 'layout.apply' || !main.apply) {
      throw new Error(`unexpected ${method}`)
    }
    return main.apply(params.command)
  }
}))

createStoreSessionMockApi()

const CLI_PTY = `${GIT_KEY}@@c1100001`
const CLI_PANE = `tab-cli:${leaf(1)}`

function cliSession(bound = true): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-cli', tabs: [{ id: 'tab-cli', leaves: [[leaf(1), bound ? CLI_PTY : undefined]] }] }
  ])
}

const unowned: LiveTerminalSurfaceOwnerIndex = new Map([
  [CLI_PTY, { unowned: true, recorded: { paneKey: CLI_PANE, ptyId: CLI_PTY, tabId: 'tab-cli' } }]
])

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function frameOf(model: WorkspaceLayoutModel): WorkspaceLayoutChangeFrame {
  return {
    type: 'snapshot',
    workspaces: Object.entries(model.workspaces).map(([key, workspace]) => ({
      key,
      layout: publishWorkspaceLayout(workspace, 'local')
    }))
  }
}

describe('a CLI terminal the window never mounted, layout-owner build', () => {
  let sync: WorkspaceLayoutFrameSync | null = null
  let model: WorkspaceLayoutModel
  let streamUp: boolean
  /** Every layout command the window sent main. */
  let applied: LayoutCommand[] = []

  beforeEach(() => {
    sync?.close()
    sync = null
    streamUp = true
    model = loadWorkspaceLayoutWithoutReport('local', cliSession(), nameBasedLoadContext()).layout
    applied = []
    main.apply = (command) => {
      applied.push(command)
      const result = applyLayoutCommand(model, command, {
        mintId: () => 'minted-tab',
        mintLeafId: () => leaf(9),
        now: () => 1
      })
      if (!result.ok) {
        return { ok: false, code: result.code }
      }
      model = result.model
      if (streamUp) {
        stream.onFrame!(frameOf(model))
      }
      return { ok: true, result: result.result }
    }
  })

  async function bootWindow() {
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: emptySession() }])
    sync = openWorkspaceLayoutFrameSync(store)
    provideLayoutFrameTerminalPanes(sync)
    sync.start()
    return store
  }

  const terminalTabIds = (store: Awaited<ReturnType<typeof bootWindow>>) =>
    (store.getState().tabsByWorktree[GIT_KEY] ?? []).map((tab) => tab.id)
  const mainTabIds = () => (model.workspaces[GIT_KEY]?.tabs ?? []).map((tab) => tab.id)

  it('the stream is closed during the visit: the window draws nothing, and the reopened stream draws main’s tab', async () => {
    const store = await bootWindow()
    stream.onFrame!(frameOf(model))
    await flushMicrotasks()
    stream.onStatus!({ state: 'lost' })
    streamUp = false
    store.getState().ensureWorktreeRootGroup(GIT_KEY)
    await flushMicrotasks()
    expect(terminalTabIds(store)).toEqual([])
    const createTab = vi.spyOn(store.getState(), 'createTab')

    const adoption = await adoptLiveWorkspacePtySurfaces(
      store.getState,
      GIT_KEY,
      [CLI_PTY],
      async () => unowned
    )
    await flushMicrotasks()

    // A closed stream cannot say main still holds it: declined, not drawn by the window.
    expect(adoption).toEqual({ surfaced: false, declinedPtyIds: [CLI_PTY] })
    expect(createTab).not.toHaveBeenCalled()
    expect(applied).toEqual([])
    stream.onStatus!({ state: 'connecting' })
    streamUp = true
    stream.onFrame!(frameOf(model))
    await flushMicrotasks()
    expect(terminalTabIds(store)).toEqual(['tab-cli'])
  })

  it('main’s binding frame arrives after the census: the window draws nothing, and that frame draws main’s tab', async () => {
    const store = await bootWindow()
    const before = loadWorkspaceLayoutWithoutReport('local', emptySession(), nameBasedLoadContext())
    stream.onFrame!(frameOf(before.layout))
    store.getState().ensureWorktreeRootGroup(GIT_KEY)
    // Main admitted the CLI pane before its spawn bound it; no frame of it has arrived yet.
    model = loadWorkspaceLayoutWithoutReport(
      'local',
      cliSession(false),
      nameBasedLoadContext()
    ).layout
    streamUp = false
    const createTab = vi.spyOn(store.getState(), 'createTab')

    const adoption = await adoptLiveWorkspacePtySurfaces(
      store.getState,
      GIT_KEY,
      [CLI_PTY],
      async () => unowned
    )
    await flushMicrotasks()

    expect(adoption).toEqual({ surfaced: false, declinedPtyIds: [CLI_PTY] })
    expect(createTab).not.toHaveBeenCalled()
    expect(applied).toEqual([])
    streamUp = true
    stream.onFrame!(frameOf(model))
    await flushMicrotasks()
    expect(terminalTabIds(store)).toEqual(['tab-cli'])
  })

  it('a background wake on a workspace the window does not hold: the visit shows main’s one tab', async () => {
    const store = await bootWindow()
    stream.onFrame!(frameOf(model))
    await flushMicrotasks()
    const createTab = vi.spyOn(store.getState(), 'createTab')

    const outcome = await runWorktreeAgentActivationGate(GIT_KEY, {
      getState: store.getState,
      awaitReady: async () => true,
      listSessions: async () => [
        { id: CLI_PTY, cwd: '/', title: '', worktreeId: GIT_KEY, agentOwnership: 'absent' }
      ],
      listSurfaceOwners: async () => unowned,
      hasStructuredSession: async () => false,
      resume: () => 0
    })
    await flushMicrotasks()

    expect(outcome).toBe('adopted')
    expect(createTab).not.toHaveBeenCalled()
    expect(applied).toEqual([])
    expect(mainTabIds()).toEqual(['tab-cli'])
    store.getState().ensureWorktreeRootGroup(GIT_KEY)
    await flushMicrotasks()
    expect(terminalTabIds(store)).toEqual(['tab-cli'])
  })

  it('declines a terminal main holds in no pane, rather than making a tab or asking main', async () => {
    const store = await bootWindow()
    model = loadWorkspaceLayoutWithoutReport('local', emptySession(), nameBasedLoadContext()).layout
    stream.onFrame!(frameOf(model))
    await flushMicrotasks()
    const createTab = vi.spyOn(store.getState(), 'createTab')

    const adoption = await adoptLiveWorkspacePtySurfaces(
      store.getState,
      GIT_KEY,
      [CLI_PTY],
      async () => unowned
    )

    expect(adoption).toEqual({ surfaced: false, declinedPtyIds: [CLI_PTY] })
    expect(createTab).not.toHaveBeenCalled()
    expect(applied).toEqual([])
  })
})
