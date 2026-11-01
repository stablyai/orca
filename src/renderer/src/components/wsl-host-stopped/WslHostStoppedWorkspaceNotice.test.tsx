import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WslHostStoppedWorkspaceNotice } from './WslHostStoppedWorkspaceNotice'

type MockState = {
  wslHostStatuses: Record<string, { state: string; distro: string }>
  unifiedTabsByWorktree: Record<string, { id: string }[]>
  tabsByWorktree: Record<string, { id: string }[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  openFiles: { worktreeId: string }[]
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))
vi.mock('../terminal-pane/remote-server-outage', () => ({
  selectWorkspaceRuntimeEnvironmentId: (_state: unknown, worktreeId: string | null) =>
    worktreeId === 'wt-wsl' ? 'wsl:ubuntu' : null
}))
vi.mock('../terminal-pane/use-wsl-host-unavailable-reason', () => ({
  selectWslHostUnavailableReason: () => null
}))

describe('WslHostStoppedWorkspaceNotice', () => {
  beforeEach(() => {
    mockState = {
      wslHostStatuses: {
        'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' }
      },
      unifiedTabsByWorktree: {},
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      openFiles: []
    }
  })

  it('offers Start in a workspace with no tabs whose host is stopped', () => {
    const markup = renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId="wt-wsl" />)
    expect(markup).toContain('Ubuntu is stopped')
    expect(markup).toContain('Start')
  })

  it('stays out of a workspace that has a tab, since that surface shows its own Start', () => {
    mockState.unifiedTabsByWorktree = { 'wt-wsl': [{ id: 'tab-1' }] }
    expect(renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId="wt-wsl" />)).toBe('')
    mockState.unifiedTabsByWorktree = {}
    mockState.openFiles = [{ worktreeId: 'wt-wsl' }]
    expect(renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId="wt-wsl" />)).toBe('')
  })

  it('stays out of a running host, a local workspace and no workspace', () => {
    expect(renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId="wt-local" />)).toBe('')
    expect(renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId={null} />)).toBe('')
    mockState.wslHostStatuses = {
      'wsl:ubuntu': { state: 'ready', distro: 'Ubuntu' }
    }
    expect(renderToStaticMarkup(<WslHostStoppedWorkspaceNotice worktreeId="wt-wsl" />)).toBe('')
  })
})
