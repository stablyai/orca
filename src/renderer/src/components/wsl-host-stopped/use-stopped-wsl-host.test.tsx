import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStoppedWslHost } from './use-stopped-wsl-host'

type MockState = {
  wslHostStatuses: Record<string, { state: string; distro: string }>
}

let mockState: MockState
const unavailable = vi.hoisted((): { reason: string | null } => ({
  reason: null
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))
vi.mock('../terminal-pane/remote-server-outage', () => ({
  selectWorkspaceRuntimeEnvironmentId: (_state: unknown, worktreeId: string | null) =>
    worktreeId === 'wt-wsl' ? 'wsl:ubuntu' : null
}))
vi.mock('../terminal-pane/use-wsl-host-unavailable-reason', () => ({
  selectWslHostUnavailableReason: () => unavailable.reason
}))

function Probe({ worktreeId }: { worktreeId: string | null }) {
  const host = useStoppedWslHost(worktreeId)
  return <span>{host ? `${host.environmentId}|${host.distro}` : 'none'}</span>
}

describe('useStoppedWslHost', () => {
  beforeEach(() => {
    unavailable.reason = null
    mockState = {
      wslHostStatuses: {
        'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' }
      }
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
    mockState = {
      wslHostStatuses: { 'wsl:ubuntu': { state: 'ready', distro: 'Ubuntu' } }
    }
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe('<span>none</span>')
  })

  it('leaves a host that cannot run to its own notice', () => {
    unavailable.reason = 'turned-off'
    expect(renderToStaticMarkup(<Probe worktreeId="wt-wsl" />)).toBe('<span>none</span>')
  })
})
