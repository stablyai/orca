// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SessionGridItem } from '../../../../shared/session-grid-types'
import { useSessionGridCardTerminalInput } from './session-grid-card-terminal-input'

vi.mock('@/components/dashboard/dashboard-client-host', () => ({
  readDashboardClientHost: () => ({
    platform: 'darwin',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    osRelease: undefined
  })
}))

const PANE_KEY = 'tab-1:00000000-0000-4000-8000-000000000001'

function item(overrides: Partial<SessionGridItem> = {}): SessionGridItem {
  return {
    tabId: 'tab-1',
    ptyId: 'pty-1',
    paneKey: PANE_KEY,
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repoName: 'repo',
    worktreeName: 'repo',
    title: 'Session',
    dotState: 'idle',
    hasUnread: false,
    attentionBadge: null,
    isHiddenFromGrid: false,
    createdAt: 1,
    hostKind: 'local',
    executionHostId: 'local',
    cwd: '/Users/dev/repo',
    shellOverride: undefined,
    launchAgent: undefined,
    ...overrides
  }
}

describe('useSessionGridCardTerminalInput', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }] as never,
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] } as never,
      paneForegroundAgentByPaneKey: {}
    })
  })

  it('resolves host-side input facts for a live pane', () => {
    const { result } = renderHook(() => useSessionGridCardTerminalInput(item()))
    expect(result.current).toMatchObject({ hostPlatform: 'darwin', localWindowsConpty: false })
  })

  it('resolves nothing for a card with no live pty, so the preview falls back by client OS', () => {
    const { result } = renderHook(() =>
      useSessionGridCardTerminalInput(item({ ptyId: null, paneKey: null }))
    )
    expect(result.current).toBeNull()
  })

  it('keeps its result across a store write that touches none of its inputs', () => {
    const { result } = renderHook(() => useSessionGridCardTerminalInput(item()))
    const before = result.current
    act(() => {
      useAppStore.setState({ sessionsGridZoom: 1.5 })
    })
    expect(result.current).toBe(before)
  })

  it('re-resolves when the agent evidence for its pane moves', () => {
    const { result } = renderHook(() => useSessionGridCardTerminalInput(item()))
    const before = result.current
    act(() => {
      useAppStore.setState({
        paneForegroundAgentByPaneKey: {
          [PANE_KEY]: { agent: 'droid', routingTrusted: true, shellForeground: false }
        } as never
      })
    })
    expect(result.current).not.toBe(before)
    expect(result.current?.ctrlEnterCsiU).toBe(true)
  })
})
