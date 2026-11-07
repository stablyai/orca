// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))
vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => true
}))

const { WorktreeCardStatusSlot } = await import('./WorktreeCardStatusSlot')

function renderSlot(prDisplay: React.ComponentProps<typeof WorktreeCardStatusSlot>['prDisplay']) {
  return render(
    <WorktreeCardStatusSlot
      worktreeId="wt-1"
      showStatus
      showUnreadAction={false}
      isUnread={false}
      unreadTooltip=""
      onToggleUnread={() => {}}
      onPointerDown={() => {}}
      prDisplay={prDisplay}
      newCardStyle
      hasBranchIdentity
    />
  )
}

describe('WorktreeCardStatusSlot sleeping precedence', () => {
  afterEach(cleanup)

  it('keeps the review icon instead of the moon when a sleeping workspace has a PR', () => {
    const { container } = renderSlot({
      provider: 'github',
      number: 7,
      title: 'Fix',
      state: 'draft'
    })
    expect(container.querySelector('.lucide-moon')).toBeNull()
  })

  it('still shows the moon for a sleeping workspace without a review', () => {
    const { container } = renderSlot(null)
    expect(container.querySelector('.lucide-moon')).not.toBeNull()
  })
})
