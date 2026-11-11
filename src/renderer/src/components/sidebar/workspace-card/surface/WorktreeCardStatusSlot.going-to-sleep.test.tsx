// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  clearWorktreeGoingToSleep,
  markWorktreeGoingToSleep,
  resetWorktreeSleepViewForTests
} from '@/lib/worktree-sleep-view'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'

vi.mock('@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false,
  selectIsSleepingWorktree: () => false
}))
// The terminal restored from before the sleep still reads as activity.
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

const noop = (): void => {}
const slot = (worktreeId: string) => (
  <TooltipProvider>
    <WorktreeCardStatusSlot
      worktreeId={worktreeId}
      showStatus
      showUnreadAction={false}
      isUnread={false}
      unreadTooltip="Mark as unread"
      onToggleUnread={noop}
      onPointerDown={noop}
      newCardStyle
    />
  </TooltipProvider>
)
const green = (container: HTMLElement): boolean =>
  container.querySelector('.bg-emerald-500') !== null

describe('the row activity dot while an Orca Cloud workspace goes to sleep (RA-13b)', () => {
  afterEach(() => {
    cleanup()
    resetWorktreeSleepViewForTests()
    seedCloudWorkspaceSnapshot({})
  })

  it('turns grey from the Sleep click, before the sandbox reads asleep', () => {
    act(() => seedCloudWorkspaceSnapshot({ ids: new Set(['ws']), idsLoaded: true }))
    const { container } = render(slot('ws'))
    expect(green(container)).toBe(true)
    act(() => markWorktreeGoingToSleep('ws'))
    expect(green(container)).toBe(false)
    act(() => clearWorktreeGoingToSleep('ws'))
    expect(green(container)).toBe(true)
  })

  it('leaves a workspace that is not on Orca Cloud alone', () => {
    act(() => seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true }))
    const { container } = render(slot('local'))
    act(() => markWorktreeGoingToSleep('local'))
    expect(green(container)).toBe(true)
  })
})
