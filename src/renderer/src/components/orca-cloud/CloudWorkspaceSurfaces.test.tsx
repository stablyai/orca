// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudWorkspaceMarkSlot } from './CloudWorkspaceMarkSlot'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  seedCloudWorkspaceSnapshot({})
})

const noop = (): void => {}

describe('Orca Cloud surfaces', () => {
  it('the sidebar slot shows the fallback for ordinary workspaces and the cloud mark for cloud ones', () => {
    const { container, rerender } = render(
      <CloudWorkspaceMarkSlot workspaceId="ws" fallback={<span data-testid="server" />} />
    )
    expect(container.querySelector('[data-testid="server"]')).not.toBeNull()
    act(() => seedCloudWorkspaceSnapshot({ ids: new Set(['ws']) }))
    rerender(<CloudWorkspaceMarkSlot workspaceId="ws" fallback={<span data-testid="server" />} />)
    expect(container.querySelector('[data-testid="server"]')).toBeNull()
    const mark = container.querySelector('[data-cloud-workspace-mark]')
    expect(mark?.getAttribute('aria-label')).toBe('Orca Cloud: Checking…')
  })

  it('the status panel offers Restart only where it helps, and Unarchive for archived', () => {
    const onRestart = vi.fn()
    const entry = { status: null, loading: false, error: null, fetchedAt: null }
    const { getByRole, queryByRole, rerender } = render(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="unresponsive"
        entry={entry}
        pending={undefined}
        actions={{ onRestart, onArchive: noop, onUnarchive: noop }}
      />
    )
    fireEvent.click(getByRole('button', { name: /Restart/ }))
    expect(onRestart).toHaveBeenCalledTimes(1)
    rerender(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="archived"
        entry={entry}
        pending={undefined}
        actions={{ onRestart, onArchive: noop, onUnarchive: noop }}
      />
    )
    expect(queryByRole('button', { name: /Restart/ })).toBeNull()
    expect(getByRole('button', { name: /Unarchive/ })).not.toBeNull()
  })

  it('the waking overlay counts seconds and turns into a recoverable error on failure', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const wake = { workspaceId: 'ws', phase: 'waking' as const, source: 'open' as const, startedAt: 1_800_000_000_000 - 3_200, at: 1_800_000_000_000 }
    const { container, getByRole, rerender } = render(
      <CloudWakingOverlay wake={wake} workspaceName="w" onRetry={noop} onRestart={noop} />
    )
    expect(getByRole('status').textContent).toMatch(/Waking…\s*3s/)
    const onRetry = vi.fn()
    rerender(
      <CloudWakingOverlay wake={{ ...wake, phase: 'failed' }} workspaceName="w" onRetry={onRetry} onRestart={noop} />
    )
    expect(getByRole('alert').textContent).toContain('Couldn’t wake w')
    fireEvent.click(getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
    expect(container.querySelector('[data-cloud-waking-overlay="failed"]')).not.toBeNull()
  })

  it('the OOM notice names the killed process and can be dismissed', () => {
    const onDismiss = vi.fn()
    const { getByRole } = render(
      <CloudWorkspaceNotice
        notice={{ kind: 'oom', oom: { workspaceId: 'ws', oomKills: 1, victim: 'node', at: 1 } }}
        restarting={false}
        onRestart={noop}
        onDismiss={onDismiss}
      />
    )
    expect(getByRole('alert').textContent).toContain('A process (node) ran out of memory')
    fireEvent.click(getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
