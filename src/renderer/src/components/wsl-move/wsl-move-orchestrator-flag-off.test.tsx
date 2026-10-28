// @vitest-environment happy-dom

/**
 * D3a-2 with WSL hosts switched off: the host rows show no move status line, and the window
 * never asks main for the orchestrator's records or listens for them.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gate = vi.hoisted(() => ({ enabled: false }))
vi.mock('../sidebar/use-wsl-hosts-enabled', () => ({
  useWslHostsEnabled: () => gate.enabled,
  useWslHostServerFilesMissing: () => false,
  wslHostsAvailable: () => true,
  openWslHostsExperimentalSetting: vi.fn()
}))
const state = vi.hoisted(() => ({
  runtimeEnvironments: [
    {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 1, remotePort: 2 }
    }
  ],
  wslHostStatuses: {},
  activeWorktreeId: null,
  tabsByWorktree: {}
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('../sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('../sidebar/HostRemoveDialog', () => ({ HostRemoveDialog: () => null }))

const { WslHostsSection } = await import('../settings/WslHostsSection')
const { WslMoveDialogHost } = await import('./WslMoveDialog')
const { useWslMoveOrchestratorStatus } = await import('./wsl-move-orchestrator-status')
const { TooltipProvider } = await import('@/components/ui/tooltip')

let listOrchestrator: ReturnType<typeof vi.fn>
let onOrchestratorStatus: ReturnType<typeof vi.fn>

beforeEach(() => {
  listOrchestrator = vi.fn(async () => [])
  onOrchestratorStatus = vi.fn(() => () => {})
  vi.stubGlobal('api', {
    wslMove: {
      listOrchestrator,
      onOrchestratorStatus,
      onProgress: () => () => {},
      onOrchestratorSleptPanesRequest: () => () => {},
      orchestratorProjectOpened: vi.fn(async () => {}),
      listUnfinished: vi.fn(async () => [])
    }
  })
  // A record a window could still hold: the row must not show it while hosts are off.
  useWslMoveOrchestratorStatus.setState({
    records: {
      ['ubuntu']: {
        distro: 'Ubuntu',
        state: { kind: 'parked', reason: 'stuck' },
        attempts: 0,
        appVersion: '1.0.0',
        updatedAt: 0
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the move status line with WSL hosts off', () => {
  it('shows no status line on the host row', () => {
    gate.enabled = false
    const { container } = render(
      <TooltipProvider>
        <WslHostsSection onChanged={() => {}} />
      </TooltipProvider>
    )
    expect(container.textContent).toContain('Ubuntu (WSL)')
    expect(container.querySelector('[data-testid="wsl-move-orchestrator-status"]')).toBeNull()
  })

  it('never reads or follows the orchestrator', () => {
    gate.enabled = false
    render(<WslMoveDialogHost />)
    expect(listOrchestrator).not.toHaveBeenCalled()
    expect(onOrchestratorStatus).not.toHaveBeenCalled()
  })

  it('follows it, and shows the line, once hosts are on', async () => {
    gate.enabled = true
    render(<WslMoveDialogHost />)
    expect(onOrchestratorStatus).toHaveBeenCalledTimes(1)
    expect(listOrchestrator).toHaveBeenCalledTimes(1)
    cleanup()
    useWslMoveOrchestratorStatus.setState({
      records: {
        ['ubuntu']: {
          distro: 'Ubuntu',
          state: { kind: 'parked', reason: 'stuck' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      }
    })
    const { container } = render(
      <TooltipProvider>
        <WslHostsSection onChanged={() => {}} />
      </TooltipProvider>
    )
    expect(container.querySelector('[data-testid="wsl-move-orchestrator-status"]')).not.toBeNull()
  })
})
