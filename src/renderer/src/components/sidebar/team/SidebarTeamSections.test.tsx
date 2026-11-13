// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DIRECTORY, SELF_ID } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import {
  SidebarFollowingSection,
  SidebarTeamList,
  type SidebarTeammate
} from './SidebarTeamSections'

afterEach(() => cleanup())
beforeEach(() => window.localStorage.clear())

const noop = (): void => {}

function team(ids: string[], active: Record<string, 'viewing' | 'typing'> = {}): SidebarTeammate[] {
  return ids.map((userId) => ({
    userId,
    activity: active[userId] ? { state: active[userId], workspaceLabel: 'Checkout' } : null
  }))
}

function renderTeam(members: SidebarTeammate[], onShowWorkspaces = noop, onOpenProfile = noop) {
  return render(
    <TooltipProvider>
      <SidebarTeamList
        members={members}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpenProfile={onOpenProfile}
        onShowWorkspaces={onShowWorkspaces}
      />
    </TooltipProvider>
  )
}

describe('SidebarTeamList (PARITY-FOLLOW)', () => {
  it('lists teammates, active first, never you', () => {
    const { container } = renderTeam(
      team([SELF_ID, 'user_alan', 'user_grace'], { user_grace: 'typing' })
    )
    const rows = [...container.querySelectorAll('div[role="button"]')]
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Grace Hopper, Typing in Checkout',
      'Alan Kay'
    ])
  })

  it('hides itself for a team of one', () => {
    const { container } = renderTeam(team([SELF_ID]))
    expect(container.textContent).toBe('')
  })

  it('caps the list at 6 with "Show all"', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `user_${i}`)
    renderTeam(team(ids))
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    fireEvent.click(screen.getByRole('button', { name: 'Show all 8' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(8)
  })

  it('opens a profile from the row and a teammate’s workspaces from its action', () => {
    const openProfile = vi.fn()
    const showWorkspaces = vi.fn()
    renderTeam(team(['user_grace']), showWorkspaces, openProfile)
    fireEvent.click(screen.getByRole('button', { name: 'Grace Hopper' }))
    expect(openProfile).toHaveBeenCalledWith('user_grace')
    fireEvent.click(screen.getByRole('button', { name: 'Grace Hopper’s workspaces' }))
    expect(showWorkspaces).toHaveBeenCalledWith('user_grace')
    expect(openProfile).toHaveBeenCalledTimes(1)
  })

  it('remembers its collapsed state for this member', () => {
    renderTeam(team(['user_grace']))
    fireEvent.click(screen.getByRole('button', { name: /Team/ }))
    expect(screen.queryByRole('listitem')).toBeNull()
    cleanup()
    renderTeam(team(['user_grace']))
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(screen.getByRole('button', { name: /Team/ }).getAttribute('aria-expanded')).toBe('false')
  })
})

describe('SidebarFollowingSection (PARITY-FOLLOW)', () => {
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
