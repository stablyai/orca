// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudWorkspaceMarkSlot } from './CloudWorkspaceMarkSlot'
import { CloudWakingOverlay } from './CloudWakingOverlay'
import { CloudWorkspaceNotice } from './CloudWorkspaceNotice'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import { CloudGitChanges } from './CloudGitChanges'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))

const T0 = 1_800_000_000_000

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  seedCloudWorkspaceSnapshot({})
})

const noop = (): void => {}
const actions = (
  over: Partial<Record<'onWake' | 'onRestart' | 'onArchive' | 'onUnarchive', () => void>> = {}
) => ({
  onWake: noop,
  onRestart: noop,
  onArchive: noop,
  onUnarchive: noop,
  ...over
})
const empty = { status: null, loading: false, error: null, fetchedAt: null }

describe('Orca Cloud surfaces', () => {
  it('the sidebar slot shows the fallback for ordinary workspaces and the cloud mark for cloud ones', () => {
    const { container, rerender } = render(
      <CloudWorkspaceMarkSlot workspaceId="ws" fallback={<span data-testid="server" />} />
    )
    expect(container.querySelector('[data-testid="server"]')).not.toBeNull()
    act(() => seedCloudWorkspaceSnapshot({ ids: new Set(['ws']), idsLoaded: true }))
    rerender(<CloudWorkspaceMarkSlot workspaceId="ws" fallback={<span data-testid="server" />} />)
    expect(container.querySelector('[data-testid="server"]')).toBeNull()
    const mark = container.querySelector('[data-cloud-workspace-mark]')
    expect(mark?.getAttribute('aria-label')).toBe('Sandbox: Checking…')
  })

  it('the panel: Restart primary only when not responding, Wake when asleep, Unarchive when archived', () => {
    const onRestart = vi.fn()
    const { getByRole, queryByRole, rerender } = render(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="unresponsive"
        entry={empty}
        pending={undefined}
        actions={actions({ onRestart })}
      />
    )
    fireEvent.click(getByRole('button', { name: /Restart/ }))
    expect(onRestart).toHaveBeenCalledTimes(1)
    const onWake = vi.fn()
    rerender(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="sleeping"
        entry={empty}
        pending={undefined}
        actions={actions({ onWake })}
      />
    )
    expect(queryByRole('button', { name: /Restart/ })).toBeNull()
    fireEvent.click(getByRole('button', { name: /Wake/ }))
    expect(onWake).toHaveBeenCalled()
    rerender(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="archived"
        entry={empty}
        pending={undefined}
        actions={actions()}
      />
    )
    expect(getByRole('button', { name: /Unarchive/ })).not.toBeNull()
  })

  it('while restarting the panel says so, hides meters and keeps the busy button focusable', () => {
    const onRestart = vi.fn()
    const { getByRole, container } = render(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="unresponsive"
        entry={empty}
        pending="restart"
        actions={actions({ onRestart })}
      />
    )
    expect(container.textContent).toContain('Restarting')
    expect(container.textContent).not.toContain('Not responding')
    const busy = getByRole('button', { name: /Restarting/ })
    expect(busy.hasAttribute('disabled')).toBe(false)
    expect(busy.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(busy)
    expect(onRestart).not.toHaveBeenCalled()
  })

  it('a status error gets its own header and Retry, not "Checking…"', () => {
    const { container, getByRole } = render(
      <CloudWorkspaceStatusPanel
        workspaceId="ws"
        state="unknown"
        entry={{ ...empty, error: 'down' }}
        pending={undefined}
        actions={actions()}
      />
    )
    expect(container.textContent).toContain('Status unavailable')
    expect(container.textContent).not.toContain('Checking')
    expect(getByRole('button', { name: /Retry/ })).not.toBeNull()
  })

  it('the waking overlay: counts seconds, says when slow, offers recovery when stuck', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const wake = {
      workspaceId: 'ws',
      phase: 'waking' as const,
      source: 'open' as const,
      startedAt: T0 - 3_200,
      at: T0
    }
    const props = {
      workspaceName: 'w',
      autoFocus: false,
      onRetry: noop,
      onRestart: noop,
      onDismiss: noop
    }
    const { container, queryByRole, rerender } = render(
      <CloudWakingOverlay wake={wake} {...props} />
    )
    expect(container.textContent).toMatch(/Waking…\s*3s/)
    expect(queryByRole('button', { name: 'Try again' })).toBeNull()
    rerender(<CloudWakingOverlay wake={{ ...wake, startedAt: T0 - 25_000 }} {...props} />)
    expect(container.textContent).toContain('Taking longer than usual')
    rerender(<CloudWakingOverlay wake={{ ...wake, startedAt: T0 - 65_000 }} {...props} />)
    expect(queryByRole('button', { name: 'Try again' })).not.toBeNull()
  })

  it('type-through: slow at 10 s with the reassurance, Connecting… once up, keys waiting in plural', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const wake = {
      workspaceId: 'ws',
      phase: 'waking' as const,
      source: 'open' as const,
      startedAt: T0 - 9_000,
      at: T0
    }
    const props = {
      workspaceName: 'w',
      autoFocus: false,
      typeThrough: true,
      onRetry: noop,
      onRestart: noop,
      onDismiss: noop
    }
    const { container, queryByRole, rerender } = render(
      <CloudWakingOverlay wake={wake} pendingInput={1} {...props} />
    )
    expect(container.textContent).not.toContain('Taking longer')
    expect(container.textContent).toContain('1 key waiting · it goes to the terminal when it’s up')
    rerender(
      <CloudWakingOverlay wake={{ ...wake, startedAt: T0 - 10_000 }} pendingInput={12} {...props} />
    )
    expect(container.textContent).toContain(
      'Taking longer than usual. Your files and chats are safe.'
    )
    expect(container.textContent).toContain(
      '12 keys waiting · they go to the terminal when it’s up'
    )
    // Still the pill (no skeleton cover), and recovery only once stuck.
    expect(container.querySelector('[data-cloud-waking-overlay]')?.className).toContain(
      'justify-end'
    )
    expect(queryByRole('button', { name: 'Try again' })).toBeNull()
    rerender(
      <CloudWakingOverlay
        wake={{ ...wake, phase: 'connecting', startedAt: T0 - 4_000 }}
        {...props}
      />
    )
    expect(container.textContent).toMatch(/Connecting…\s*4s/)
  })

  it('a failed wake is a dismissible alert whose primary action is Try again', () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    const { getByRole } = render(
      <CloudWakingOverlay
        wake={{ workspaceId: 'ws', phase: 'failed', source: 'open', startedAt: 1, at: 2 }}
        workspaceName="w"
        onRetry={onRetry}
        onRestart={noop}
        onDismiss={onDismiss}
      />
    )
    expect(getByRole('alert').textContent).toContain('Couldn’t wake w')
    expect(document.activeElement?.textContent).toBe('Try again')
    fireEvent.click(getByRole('button', { name: 'Try again' }))
    fireEvent.click(getByRole('button', { name: 'Dismiss' }))
    expect(onRetry).toHaveBeenCalled()
    expect(onDismiss).toHaveBeenCalled()
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
    expect(getByRole('alert').textContent).toContain('node ran out of memory')
    expect(getByRole('alert').textContent).toContain('It was stopped')
    fireEvent.click(getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('git changes read the same for porcelain letters and the cache’s words, with sr-only labels', () => {
    const { container } = render(
      <CloudGitChanges
        now={T0}
        data={{
          branch: 'main',
          diffStat: '2 files changed, 41 insertions(+), 6 deletions(-)',
          changes: [
            { status: 'modified', path: 'a.ts' },
            { status: '??', path: 'b.ts' }
          ],
          commits: []
        }}
      />
    )
    expect(container.textContent).toContain('2 files +41 −6')
    expect(container.textContent).toContain('Modified:')
    expect(container.textContent).toContain('Untracked:')
  })
})
