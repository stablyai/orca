import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStoppedWslHost } from './use-stopped-wsl-host'

type MockState = {
  wslHostStatuses: Record<string, { state: string; distro: string }>
  wslHostServerFiles: 'unknown' | 'present' | 'missing'
  settings: { experimentalWslHosts: boolean }
  runtimeEnvironments: { id: string; orcadDeployment?: { kind: string } }[]
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))
vi.mock('../terminal-pane/remote-server-outage', () => ({
  selectWorkspaceRuntimeEnvironmentId: (_state: unknown, worktreeId: string | null) =>
    worktreeId === 'wt-wsl' ? 'wsl:ubuntu' : null
}))
// The workspace's owner, so every selector on the path reads a full workspace instead of the store's repos.
vi.mock('@/lib/workspace-row-owner-host', () => ({
  workspaceOwnerHostId: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-wsl' ? 'runtime:wsl:ubuntu' : null
}))

function Probe({ worktreeId }: { worktreeId: string | null }) {
  const host = useStoppedWslHost(worktreeId)
  return <span>{host ? `${host.environmentId}|${host.distro}` : 'none'}</span>
}

describe('useStoppedWslHost', () => {
  beforeEach(() => {
    mockState = {
      wslHostStatuses: { 'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' } },
      wslHostServerFiles: 'present',
      settings: { experimentalWslHosts: true },
      runtimeEnvironments: [{ id: 'wsl:ubuntu', orcadDeployment: { kind: 'wsl' } }]
    }
  })

  it('names the workspace host and its distro while the distro is stopped', () => {
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe(
      '<span>wsl:ubuntu|Ubuntu</span>'
    )
  })

  it('is null for a running host, a local workspace, or no workspace', () => {
    expect(renderToStaticMarkup(<Probe worktreeId="wt-local" />)).toBe('<span>none</span>')
    expect(renderToStaticMarkup(<Probe worktreeId={null} />)).toBe('<span>none</span>')
    mockState.wslHostStatuses = { 'wsl:ubuntu': { state: 'ready', distro: 'Ubuntu' } }
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe('<span>none</span>')
  })

  it('leaves a host whose server files are missing to its own notice', () => {
    mockState.wslHostServerFiles = 'missing'
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe('<span>none</span>')
  })

  it('still offers Start with the setting off while a saved host serves', () => {
    mockState.settings = { experimentalWslHosts: false }
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe(
      '<span>wsl:ubuntu|Ubuntu</span>'
    )
  })

  it('leaves a turned-off host, with no saved WSL host serving, to its own notice', () => {
    mockState.settings = { experimentalWslHosts: false }
    mockState.runtimeEnvironments = [{ id: 'ssh:desk' }]
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe('<span>none</span>')
  })
})
