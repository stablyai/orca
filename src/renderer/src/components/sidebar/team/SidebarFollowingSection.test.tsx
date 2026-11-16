// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DIRECTORY, SELF_ID } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import { SidebarFollowingSection } from './SidebarFollowingSection'

afterEach(() => cleanup())
beforeEach(() => window.localStorage.clear())

const noop = (): void => {}

describe('SidebarFollowingSection', () => {
  it('is hidden when nothing is followed', () => {
    const { container } = render(
      <TooltipProvider>
        <SidebarFollowingSection
          workspaces={[]}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onOpen={noop}
          onUnfollow={noop}
        />
      </TooltipProvider>
    )
    expect(container.textContent).toBe('')
  })

  it('opens a followed workspace and unfollows from the row action', () => {
    const onOpen = vi.fn()
    const onUnfollow = vi.fn()
    render(
      <TooltipProvider>
        <SidebarFollowingSection
          workspaces={[
            {
              sandboxId: 'sbx_a',
              title: 'Checkout retries',
              numberLabel: 'W-582',
              creatorId: 'user_grace',
              status: 'asleep',
              hereNow: 0
            }
          ]}
          directory={DIRECTORY}
          selfId={SELF_ID}
          onOpen={onOpen}
          onUnfollow={onUnfollow}
        />
      </TooltipProvider>
    )
    expect(screen.getByText('Asleep')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unfollow Checkout retries' }))
    expect(onUnfollow).toHaveBeenCalledWith('sbx_a')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Checkout retries'))
    expect(onOpen).toHaveBeenCalledWith('sbx_a')
  })
})
