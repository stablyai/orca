// While main's local layout stream is down, a change the window sends is applied by main but not
// drawn by the window; the reopened stream's snapshot shows it. The local host is the same build,
// so the window never needs to draw these itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { useAppStore } from '@/store'
import {
  applyLayoutCommand,
  renameTabCommandsOf
} from '../../../shared/workspace-layout/workspace-layout-commands'
import type {
  LayoutApplyReply,
  LayoutCommandResult,
  RenameTabsCommand,
  UntitledTab
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { testContext } from '../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  GIT_KEY,
  leaf
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { dropTabThroughLayoutOwner } from '../components/tab-group/tab-group-layout-owner-commands'
import { applyRuntimePaneTitle } from '../hooks/ipc-events/terminal-pane-title-ipc-bridge'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { endLayoutFramePositions } from './layout-frame-position'
import type { AppliedLayoutCommand } from './layout-apply-test-double'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import type { RuntimeLayoutStreamStatus } from './runtime-layout-client'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// The test opens its own stream: boot's document-long one would outlive the test's double.
vi.mock('./workspace-layout-frame-sync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showStartupLayoutFrames: () => {}
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

type Call = { command: AppliedLayoutCommand; answer: (reply: LayoutApplyReply) => void }
const rpc = vi.hoisted((): { calls: Call[] } => ({ calls: [] }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: (_target: unknown, _method: string, params: { command: AppliedLayoutCommand }) =>
    new Promise<LayoutApplyReply>((answer) => rpc.calls.push({ command: params.command, answer }))
}))

type StreamDouble = {
  onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null
  onStatus: ((status: RuntimeLayoutStreamStatus) => void) | null
  onPosition: ((seq: number) => void) | null
}
const stream = vi.hoisted((): StreamDouble => ({ onFrame: null, onStatus: null, onPosition: null }))
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void,
    onStatus: (status: RuntimeLayoutStreamStatus) => void,
    onPosition: (seq: number) => void
  ) => {
    Object.assign(stream, { onFrame, onStatus, onPosition })
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
let close = (): void => {}
let model: WorkspaceLayoutModel
let seq = 0
let frames = mainLayoutFrameSender()
const published = () => ({ [GIT_KEY]: publishWorkspaceLayout(model.workspaces[GIT_KEY]!, 'local') })

beforeEach(async () => {
  rpc.calls = []
  check = installLayoutFrameApplyCheck()
  const session = localDesktopSession()
  model = loadWorkspaceLayoutWithoutReport('local', session, nameBasedLoadContext()).layout
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  frames = mainLayoutFrameSender()
  stream.onFrame!(frames.snapshot(published(), ++seq))
  stream.onPosition!(seq)
  sync.start()
  await settle()
  close = () => sync.close()
})

afterEach(() => {
  close()
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

/** Main applies each command the window sent and answers; no frame comes while the stream is down. */
async function mainAppliesEach(): Promise<void> {
  for (const call of rpc.calls.splice(0)) {
    if (call.command.type === 'renameTabs') {
      call.answer({ ok: true, result: mainRenames(call.command) })
      continue
    }
    const applied = applyLayoutCommand(model, call.command, testContext())
    if (!applied.ok) {
      throw new Error(`main refused ${call.command.type}: ${applied.code}`)
    }
    model = applied.model
    call.answer({ ok: true, result: applied.result })
  }
  await settle()
}

/** Main's `renameTabs`: each title as its `renameTab`, naming those main did not give. */
function mainRenames(command: RenameTabsCommand): LayoutCommandResult {
  const untitled: UntitledTab[] = []
  for (const rename of renameTabCommandsOf(command)) {
    const applied = applyLayoutCommand(model, rename, testContext())
    if (applied.ok) {
      model = applied.model
    } else {
      untitled.push({ workspace: rename.workspace, tabId: rename.tabId, code: applied.code })
    }
  }
  return untitled.length > 0 ? { untitled } : {}
}

const terminalRow = (id: string) =>
  useAppStore.getState().tabsByWorktree[GIT_KEY]!.find((row) => row.id === id)!
const tabEntry = (id: string) =>
  useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.id === id)!
const paneTitles = () => useAppStore.getState().terminalLayoutsByTabId['tab-shell']?.titlesByLeafId

describe('changes made while main’s layout stream is down', () => {
  it('show only once the reopened stream’s snapshot comes', async () => {
    const groupBefore = tabEntry('tab-unbound').groupId
    stream.onStatus!({ state: 'lost' })

    useAppStore.getState().setTabCustomTitle('tab-unbound', 'Outage rename')
    useAppStore.getState().setTabColor('tab-unbound', '#22c55e')
    applyRuntimePaneTitle({ tabId: 'tab-shell', leafId: leaf(1), title: 'REVIEWER' })
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'move',
      tabId: 'tab-unbound',
      groupId: 'group-a',
      index: 0
    })
    expect(rpc.calls.map((call) => call.command.type)).toEqual([
      'renameTab',
      'setTabProps',
      'renamePane',
      'moveTab'
    ])
    await mainAppliesEach()

    // Main holds every change; the window drew none of them.
    expect(groupBefore).not.toBe('group-a')
    expect(terminalRow('tab-unbound').customTitle).not.toBe('Outage rename')
    expect(terminalRow('tab-unbound').color).not.toBe('#22c55e')
    expect(paneTitles()?.[leaf(1)]).toBeUndefined()
    expect(tabEntry('tab-unbound').groupId).toBe(groupBefore)

    stream.onStatus!({ state: 'connecting' })
    stream.onFrame!(frames.snapshot(published(), ++seq))
    stream.onPosition!(seq)
    await settle()

    expect(terminalRow('tab-unbound').customTitle).toBe('Outage rename')
    expect(terminalRow('tab-unbound').color).toBe('#22c55e')
    expect(paneTitles()?.[leaf(1)]).toBe('REVIEWER')
    expect(tabEntry('tab-unbound').groupId).toBe('group-a')
    // The move's selection waited for the snapshot that shows it (L120).
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe('group-a')
    expect(
      useAppStore.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === 'group-a')
        ?.activeTabId
    ).toBe('tab-unbound')
  })
  it('keep an agent’s first generated title when a second prompt comes before the snapshot', async () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, tabAutoGenerateTitle: true }
    })
    const leafId = useAppStore.getState().terminalLayoutsByTabId['tab-unbound']!.activeLeafId!
    const paneKey = makePaneKey('tab-unbound', leafId)
    stream.onStatus!({ state: 'lost' })

    useAppStore.getState().setGeneratedTabTitleFromAgentPrompt(paneKey, 'Refactor the auth module')
    await mainAppliesEach()
    // The answer settled the first title, so the second prompt is sent too.
    useAppStore.getState().setGeneratedTabTitleFromAgentPrompt(paneKey, 'Fix the flaky login test')
    expect(rpc.calls.map((call) => call.command.type)).toEqual(['renameTabs'])
    await mainAppliesEach()
    expect(terminalRow('tab-unbound').generatedTitle).toBeUndefined()

    stream.onStatus!({ state: 'connecting' })
    stream.onFrame!(frames.snapshot(published(), ++seq))
    stream.onPosition!(seq)
    await settle()

    expect(terminalRow('tab-unbound').generatedTitle).toBe('Refactor the auth module')
  })
})
