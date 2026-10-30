import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'

const mocks = vi.hoisted(() => ({
  isWebRuntimeSessionActive: vi.fn(() => true),
  setWebRuntimeTabProps: vi.fn(() => true),
  call: vi.fn(async () => ({ ok: true, result: { rename: {} } }))
}))
vi.mock('./web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('./web-runtime-terminal-actions', () => ({
  setWebRuntimeTabProps: mocks.setWebRuntimeTabProps
}))

import { renameHostTerminalTab, renameWebRuntimeTerminal } from './web-runtime-terminal-rename'

const TAB = toWebTerminalSurfaceTabId('host-tab')

function state(
  ptyId: string | null,
  layouts: Record<string, TerminalLayoutSnapshot> = {},
  tabId = TAB
) {
  const tab: TerminalTab = {
    id: tabId,
    ptyId,
    worktreeId: 'wt',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  return { tabsByWorktree: { wt: [tab] }, terminalLayoutsByTabId: layouts }
}

describe('desktop rename of a remote server tab', () => {
  beforeEach(() => {
    mocks.call.mockClear()
    mocks.setWebRuntimeTabProps.mockClear()
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: mocks.call } } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // #29975: a desktop rename stayed local, so `orca terminal show` on the server kept the old name.
  it("renames the server's terminal by its handle", () => {
    renameHostTerminalTab(state(toRemoteRuntimePtyId('term_7', 'env-1')), TAB, '绑定')
    expect(mocks.call).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.rename',
      params: { terminal: 'term_7', title: '绑定' },
      timeoutMs: 15_000
    })
    // Retained bindings can name handles a restarted host no longer knows.
    expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: TAB,
      customTitle: '绑定'
    })
  })

  it('sends a cleared name as null', () => {
    renameWebRuntimeTerminal(toRemoteRuntimePtyId('term_7', 'env-1'), null)
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({ params: { terminal: 'term_7', title: null } })
    )
  })

  it("names the tab through a split pane's handle when the active one is unbound", () => {
    const layout: TerminalLayoutSnapshot = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-2': toRemoteRuntimePtyId('term_8', 'env-1') }
    }
    renameHostTerminalTab(state(null, { [TAB]: layout }), TAB, 'Split')
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({ params: { terminal: 'term_8', title: 'Split' } })
    )
  })

  // Why: the host's next snapshot would otherwise revert a name it never received.
  it('names a sleeping or starting tab by its tab id', () => {
    renameHostTerminalTab(state(null), TAB, 'Later')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledWith({
      worktreeId: 'wt',
      tabId: TAB,
      customTitle: 'Later'
    })
  })

  it('leaves a local terminal alone', () => {
    renameHostTerminalTab(state('local-pty-1', {}, 'local-tab'), 'local-tab', 'x')
    expect(mocks.call).not.toHaveBeenCalled()
    expect(mocks.setWebRuntimeTabProps).not.toHaveBeenCalled()
  })

  it('does not call a server this window is no longer connected to', () => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    expect(renameWebRuntimeTerminal(toRemoteRuntimePtyId('term_7', 'env-1'), 'x')).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })
})
