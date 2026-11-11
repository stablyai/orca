// @vitest-environment happy-dom
// Frame-drawn server holds use this desktop’s newer-build banner; Reopen goes to server main and applies nothing locally.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import type * as FrameDrawnModule from '../../web-session-tabs-sync/frame-drawn-server-workspaces'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import type { NewerDaemonReopenResult } from '../../../../../shared/newer-daemon-hold'
import type {
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../../../../shared/workspace-layout/workspace-layout-published'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'
import { _resetLayoutFramePositionForTests } from '../frames/layout-frame-position'
import { NewerDaemonHoldBanner } from '@/components/terminal-pane/session-restore/newer-daemon/NewerDaemonHoldBanner'
import { newerDaemonHoldStore } from '@/components/terminal-pane/session-restore/newer-daemon/newer-daemon-hold-state'
import {
  CAPABLE,
  ENV,
  LEAF_ID,
  WT,
  createFakeLayoutStreams,
  createServerHarness,
  serverLayout,
  serverTerminalTab,
  settle,
  treeOf,
  type Server,
  type TestStore
} from './testing/server-layout-frames.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from '../../web-session-tabs-sync/frame-drawn-server-workspace-set'
import { resetMirroredTerminalHandlesForTests } from '../../web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

type Subscribe = (...args: never[]) => { close: () => void }
const hoisted = vi.hoisted(
  (): {
    owners: Map<string, string>
    resync: Mock<(environmentId: string, worktreeId: string) => Promise<void>>
    subscribe: Subscribe | null
    callRuntimeRpc: Mock<(...args: unknown[]) => Promise<NewerDaemonReopenResult>>
  } => ({
    owners: new Map(),
    resync: vi.fn(),
    subscribe: null,
    callRuntimeRpc: vi.fn()
  })
)

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('../frames/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: hoisted.callRuntimeRpc
}))
vi.mock('../../web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('../../web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const api = createStoreSessionMockApi()
const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const REOPENS: Server = { ...CAPABLE, reopensHeldPanes: true }

/** ENV's workspace with its one pane carrying `status`, as the server publishes it. */
function layoutWith(status: PaneStartStatus | undefined): PublishedWorkspaceLayout {
  const layout = serverLayout([serverTerminalTab('host-tab-1', LEAF_ID, 'server-pty-1')])
  const pane = layout.tabs[0]!.terminal!.panes[0]!
  layout.tabs[0]!.terminal!.panes[0] = status
    ? { ...pane, status, statusReason: 'terminal_held_by_newer_daemon' }
    : pane
  return layout
}

let seq = 0
async function publish(layout: PublishedWorkspaceLayout): Promise<void> {
  streams.send(streams.openTo(ENV), {
    type: 'snapshot',
    workspaces: [{ key: WT, layout }],
    seq: ++seq,
    epoch: 'e'
  })
  await settle()
}

let paneElement: HTMLDivElement
let root: Root
const pty = { reopenNewerDaemonTerminals: vi.fn() }

async function render(): Promise<void> {
  await act(async () => {
    root.render(<NewerDaemonHoldBanner tabId={TAB_1} leafId={LEAF_ID} />)
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(paneElement.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button in: ${paneElement.textContent}`)
  }
  return match
}

async function heldServerPane(server: Server = REOPENS): Promise<TestStore> {
  const store = mirroredStore()
  install(store)
  setServers(store, [server])
  await publish(layoutWith('held'))
  await render()
  return store
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  hoisted.owners.clear()
  hoisted.resync.mockReset().mockResolvedValue(undefined)
  hoisted.callRuntimeRpc.mockReset().mockResolvedValue({ reopened: true })
  pty.reopenNewerDaemonTerminals.mockReset()
  Object.assign(api.pty, pty)
  streams.all.length = 0
  seq = 0
  resetWebSessionTabsSyncTestState()
  resetFrameDrawnServerWorkspacesForTests()
  resetMirroredTerminalHandlesForTests()
  _resetLayoutFramePositionForTests()
  newerDaemonHoldStore.setState({ panes: {} })
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  uninstallAll()
  vi.unstubAllGlobals()
})

describe("a layout-owner server's held pane on a paired desktop", () => {
  it("sends Reopen to the server's main under the server's ids and applies nothing here", async () => {
    let answer!: (result: NewerDaemonReopenResult) => void
    hoisted.callRuntimeRpc.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const store = await heldServerPane()
    const before = treeOf(store.getState(), WT)

    await act(async () => button('Reopen terminal').click())

    expect(hoisted.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: ENV },
      'layout.reopenHeldPanes',
      { panes: [{ worktreeId: WT, tabId: 'host-tab-1', leafId: LEAF_ID }] },
      expect.anything()
    )
    expect(pty.reopenNewerDaemonTerminals).not.toHaveBeenCalled()
    expect(button('Reopening…').disabled).toBe(true)
    await act(async () => answer({ reopened: true }))
    // The server's frames, not the answer, end the hold.
    expect(button('Reopening…')).toBeTruthy()
    expect(treeOf(store.getState(), WT)).toEqual(before)
    await publish(layoutWith('held'))
    await render()
    expect(button('Reopening…')).toBeTruthy()

    // The reattach frame: status cleared, pane bound to its terminal.
    await publish(layoutWith(undefined))
    await render()
    expect(paneElement.textContent).toBe('')
    expect(store.getState().terminalLayoutsByTabId[TAB_1]?.ptyIdsByLeafId?.[LEAF_ID]).toMatch(
      /^remote:/
    )
  })
})
