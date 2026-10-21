// @vitest-environment happy-dom
// A layout-owner server's held pane on this desktop's existing newer-build banner: drawn from the
// server's frames, its Reopen sent to that server's main, and nothing applied here.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as FrameDrawnModule from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { NewerDaemonReopenResult } from '../../../shared/newer-daemon-hold'
import type {
  PaneStartStatus,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { _resetLayoutFramePositionForTests } from './layout-frame-position'
import { NewerDaemonHoldBanner } from '@/components/terminal-pane/NewerDaemonHoldBanner'
import {
  newerDaemonHoldStore,
  reopenHeldTerminals
} from '@/components/terminal-pane/newer-daemon-hold-state'
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
} from './server-layout-frames.test-fixture'
import { resetFrameDrawnServerWorkspacesForTests } from './web-session-tabs-sync/frame-drawn-server-workspaces'
import { resetMirroredTerminalHandlesForTests } from './web-session-tabs-sync/mirrored-terminal-handle-index'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

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

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (...args: never[]) => hoisted.subscribe!(...args)
}))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: hoisted.callRuntimeRpc }))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (_state: unknown, key: string) =>
    hoisted.owners.get(key) ?? null
}))
vi.mock('./web-session-tabs-sync/frame-drawn-server-workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof FrameDrawnModule>()),
  resyncMirroredServerWorkspace: hoisted.resync
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const api = createStoreSessionMockApi()
const streams = createFakeLayoutStreams()
hoisted.subscribe = streams.subscribe
const { setServers, mirroredStore, install, uninstallAll } = createServerHarness(hoisted)

const TAB_1 = toWebTerminalSurfaceTabId('host-tab-1')
const PANE_KEY = makePaneKey(TAB_1, LEAF_ID)
const REOPENS: Server = { ...CAPABLE, reopensHeldPanes: true }
const TITLE = 'This terminal was opened in a newer version of Orca'
const FAILED_TITLE = "Couldn't reopen this terminal"

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
  it('shows the existing banner while the frames hold it, and drops it once they do not', async () => {
    await heldServerPane()
    expect(paneElement.textContent).toContain(TITLE)
    expect(button('Reopen terminal')).toBeTruthy()

    await publish(layoutWith(undefined))
    await render()

    expect(paneElement.textContent).toBe('')
  })

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

  it.each([
    ['refuses', () => Promise.resolve({ reopened: false })],
    ['fails', () => Promise.reject(new Error('connection lost'))]
  ] as const)('shows the failed state when the server %s', async (_, reply) => {
    hoisted.callRuntimeRpc.mockImplementation(reply)
    await heldServerPane()

    await act(async () => button('Reopen terminal').click())

    expect(paneElement.textContent).toContain(FAILED_TITLE)
    expect(button('Try again').disabled).toBe(false)
    // The banner stays on the failed path while the server still holds the pane.
    await publish(layoutWith('held'))
    await render()
    expect(paneElement.textContent).toContain(FAILED_TITLE)
    expect(newerDaemonHoldStore.getState().panes[PANE_KEY]?.phase).toBe('failed')
  })

  it("stops nothing, here or on the server, for a Reopen of a pane the server's frames just dropped", async () => {
    await heldServerPane()
    await publish(layoutWith(undefined))

    await act(async () => reopenHeldTerminals(PANE_KEY))

    expect(pty.reopenNewerDaemonTerminals).not.toHaveBeenCalled()
    // The view report shares the RPC client; only a Reopen would name this method.
    expect(hoisted.callRuntimeRpc.mock.calls.map(([, method]) => method)).not.toContain(
      'layout.reopenHeldPanes'
    )
  })

  it('shows no banner for an older server that publishes no status', async () => {
    const store = mirroredStore()
    install(store)
    setServers(store, [REOPENS])
    await publish(layoutWith(undefined))
    await render()

    expect(paneElement.textContent).toBe('')
    expect(newerDaemonHoldStore.getState().panes).toEqual({})
  })

  it('shows no banner for a server with layout intents that cannot reopen held panes', async () => {
    // CAPABLE advertises layout.intents.v1 only; heldServerPane publishes the pane 'held'.
    await heldServerPane(CAPABLE)

    expect(paneElement.textContent).toBe('')
    expect(newerDaemonHoldStore.getState().panes[PANE_KEY]).toBeUndefined()
  })
})
