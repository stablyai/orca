import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stopDashboardAgent } from './stop-dashboard-agent'

const dropAgentStatus = vi.fn()
const dismissRetainedAgent = vi.fn()
const closeTerminalTab = vi.fn()
const closeWebRuntimeTerminal = vi.fn((_ptyId: string | null | undefined) => false)
const ptyKill = vi.fn()

let terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }> = {}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      dropAgentStatus,
      dismissRetainedAgent,
      terminalLayoutsByTabId
    })
  }
}))

vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: (...args: unknown[]) => closeTerminalTab(...args)
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeTerminal: (ptyId: string | null | undefined) => closeWebRuntimeTerminal(ptyId)
}))

function args(
  overrides: Partial<Parameters<typeof stopDashboardAgent>[0]> = {}
): Parameters<typeof stopDashboardAgent>[0] {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    ...overrides
  }
}

describe('stopDashboardAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeWebRuntimeTerminal.mockReturnValue(false)
    terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } }
    }
    vi.stubGlobal('window', { api: { pty: { kill: ptyKill } } })
  })

  it('drops the row before tearing the pane down so retention cannot resurrect the card', () => {
    const order: string[] = []
    dropAgentStatus.mockImplementation(() => order.push('drop'))
    dismissRetainedAgent.mockImplementation(() => order.push('dismiss'))
    closeTerminalTab.mockImplementation(() => order.push('close'))

    stopDashboardAgent(args())

    expect(order).toEqual(['drop', 'dismiss', 'close'])
    expect(dropAgentStatus).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(dismissRetainedAgent).toHaveBeenCalledWith('tab-1:leaf-1')
  })

  it('closes the whole tab when the agent is its only pane', () => {
    stopDashboardAgent(args())

    expect(closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        reason: 'user',
        rejectPinned: true
      })
    )
    expect(ptyKill).not.toHaveBeenCalled()
  })

  it('kills only the agent pane when the tab is split', () => {
    terminalLayoutsByTabId = {
      'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2' } }
    }

    stopDashboardAgent(args())

    expect(ptyKill).toHaveBeenCalledWith('pty-1')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })

  it('routes a host-owned runtime pane through the runtime close instead of pty.kill', () => {
    terminalLayoutsByTabId = {
      'tab-1': {
        ptyIdsByLeafId: { 'leaf-1': 'remote:env/1', 'leaf-2': 'pty-2' }
      }
    }
    closeWebRuntimeTerminal.mockReturnValue(true)

    stopDashboardAgent(args({ ptyId: 'remote:env/1' }))

    expect(closeWebRuntimeTerminal).toHaveBeenCalledWith('remote:env/1')
    expect(ptyKill).not.toHaveBeenCalled()
  })

  it('stops the agent anyway when a pinned tab refuses to close', () => {
    closeTerminalTab.mockImplementation((_tabId: string, options: { onCancel?: () => void }) =>
      options.onCancel?.()
    )

    stopDashboardAgent(args())

    expect(ptyKill).toHaveBeenCalledWith('pty-1')
  })

  it('only drops the row for a retained card whose pane is already gone', () => {
    stopDashboardAgent(args({ ptyId: null }))

    expect(dropAgentStatus).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(dismissRetainedAgent).toHaveBeenCalledWith('tab-1:leaf-1')
    expect(closeTerminalTab).not.toHaveBeenCalled()
    expect(ptyKill).not.toHaveBeenCalled()
  })
})
