// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { HostHeaderRow } from '../../../../shared/sidebar-list/host-section-rows'
import { HostSectionHeaderMenu } from './HostSectionHeaderMenu'

type MockState = {
  sshConnectionStates: Map<string, never>
  wslHostStatuses: Record<string, { state: string; distro: string }>
  wslHostServerFiles: 'unknown' | 'present' | 'missing'
  settings: { experimentalWslHosts: boolean }
  runtimeEnvironments: { id: string; orcadDeployment?: { kind: string } }[]
}

let mockState: MockState
const start = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: MockState) => unknown) => selector(mockState), {
    getState: () => mockState
  })
}))
vi.mock('@/lib/wsl-host-user-start', () => ({ startWslHostAndReloadProjects: start }))
vi.mock('./HostRenameDialog', () => ({ HostRenameDialog: () => null }))
vi.mock('./HostRemoveDialog', () => ({ HostRemoveDialog: () => null }))
vi.mock('../settings/RuntimeRepairDialog', () => ({ RuntimeRepairDialog: () => null }))
vi.mock('./host-rename-remove', () => ({ resolveHostRemoval: () => null }))

const row: HostHeaderRow = {
  type: 'host-header',
  key: 'host:wsl:ubuntu',
  hostId: toRuntimeExecutionHostId('wsl:ubuntu'),
  kind: 'runtime',
  label: 'Ubuntu',
  detail: '',
  health: 'available',
  collapsed: false,
  count: 1
}

function openMenu() {
  const view = render(
    <TooltipProvider>
      <HostSectionHeaderMenu row={row} />
    </TooltipProvider>
  )
  const trigger = view.getByRole('button', { name: 'Host actions for Ubuntu' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return view
}

afterEach(() => {
  cleanup()
  start.mockReset()
})

describe('HostSectionHeaderMenu Start for a stopped WSL host', () => {
  beforeEach(() => {
    mockState = {
      sshConnectionStates: new Map<string, never>(),
      wslHostStatuses: { 'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' } },
      wslHostServerFiles: 'present',
      settings: { experimentalWslHosts: true },
      runtimeEnvironments: [{ id: 'wsl:ubuntu', orcadDeployment: { kind: 'wsl' } }]
    }
  })

  it('offers Start, and boots only on select (E9)', () => {
    start.mockResolvedValue(true)
    const view = openMenu()
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('menuitem', { name: 'Start Ubuntu' }))
    expect(start).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('still offers Start with the setting off while the saved host serves', () => {
    mockState.settings = { experimentalWslHosts: false }
    expect(openMenu().queryByRole('menuitem', { name: 'Start Ubuntu' })).toBeTruthy()
  })

  it('leaves a host whose server files are missing to its own notice', () => {
    mockState.wslHostServerFiles = 'missing'
    expect(openMenu().queryByRole('menuitem', { name: 'Start Ubuntu' })).toBeNull()
  })
})
