// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { WorktreeCardStatusSlot } from '../surface/WorktreeCardStatusSlot'
import { WorktreeCardHostMark } from './WorktreeCardHostMark'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))

const runtime = (workspaceId: string, status: 'suspended' | 'resume_failed') => ({
  id: `runtime-${workspaceId}`,
  workspaceId,
  status,
  runtimeEnvironmentId: `env-${workspaceId}`,
  canSuspend: true
})

afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
  useAppStore.setState({ ephemeralVmRuntimesByWorkspaceId: {} })
})

const noop = (): void => {}
const slot = (worktreeId: string, newCardStyle: boolean) => (
  <TooltipProvider>
    <WorktreeCardStatusSlot
      worktreeId={worktreeId}
      showStatus
      showUnreadAction={!newCardStyle}
      isUnread={false}
      unreadTooltip="Mark as unread"
      onToggleUnread={noop}
      onPointerDown={noop}
      newCardStyle={newCardStyle}
    />
  </TooltipProvider>
)

describe('cloud icon rule on the card', () => {
  it('a cloud card never renders the VM state badge, even when registered as a VM runtime', () => {
    act(() => {
      useAppStore.setState({
        ephemeralVmRuntimesByWorkspaceId: {
          ws: runtime('ws', 'resume_failed'),
          vm: runtime('vm', 'resume_failed')
        }
      })
      seedCloudWorkspaceSnapshot({ ids: new Set(['ws']), idsLoaded: true })
    })
    for (const newCardStyle of [true, false]) {
      const cloudCard = render(slot('ws', newCardStyle))
      expect(cloudCard.container.querySelector('[data-worktree-vm-state]')).toBeNull()
      cloudCard.unmount()
    }
    // The guard is cloud-only: a recipe VM's failure still shows in the lane.
    const vmCard = render(slot('vm', true))
    expect(vmCard.container.querySelector('[data-worktree-vm-state]')).not.toBeNull()
  })

  it('one host slot: Cloud for cloud, Box with a badge for a recipe VM, Monitor only when mixed', () => {
    act(() => {
      useAppStore.setState({ ephemeralVmRuntimesByWorkspaceId: {} })
      seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true })
    })
    const local = render(<WorktreeCardHostMark worktreeId="local" />)
    expect(local.container.querySelector('[data-host-glyph]')).toBeNull()
    local.unmount()

    act(() => {
      useAppStore.setState({ ephemeralVmRuntimesByWorkspaceId: { vm: runtime('vm', 'suspended') } })
      seedCloudWorkspaceSnapshot({ ids: new Set(['ws']), idsLoaded: true })
    })
    const glyph = (id: string): Element | null =>
      render(<WorktreeCardHostMark worktreeId={id} />).container.querySelector('[data-host-glyph]')
    expect(glyph('ws')?.getAttribute('data-host-glyph')).toBe('orca-cloud')
    const vm = glyph('vm')
    expect(vm?.getAttribute('data-host-glyph')).toBe('recipe-vm')
    expect(vm?.querySelector('[data-cloud-state]')?.getAttribute('data-cloud-state')).toBe(
      'sleeping'
    )
    expect(glyph('local')?.getAttribute('data-host-glyph')).toBe('local')
  })
})
