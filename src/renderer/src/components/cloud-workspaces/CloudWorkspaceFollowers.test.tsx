// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CloudWorkspaceFollowers, workspaceFollowerEntries } from './CloudWorkspaceFollowers'
import { DIRECTORY, presence, SELF_ID } from './cloud-workspaces.test-fixture'

afterEach(() => cleanup())

describe('workspaceFollowerEntries (PARITY-FOLLOW)', () => {
  it('lists the creator, then followers, then visitors, each once, with live state', () => {
    expect(
      workspaceFollowerEntries({
        creatorId: 'user_grace',
        followers: ['user_linus', 'user_grace'],
        presence: [
          presence('user_mae'),
          presence('user_grace', 'typing'),
          { ...presence('user_mae', 'typing'), clientId: 'laptop-2' }
        ]
      })
    ).toEqual([
      { userId: 'user_grace', role: 'creator', state: 'typing' },
      { userId: 'user_linus', role: 'follower', state: null },
      { userId: 'user_mae', role: 'visitor', state: 'typing' }
    ])
  })
})

describe('CloudWorkspaceFollowers (PARITY-FOLLOW)', () => {
  const entries = workspaceFollowerEntries({
    creatorId: 'user_grace',
    followers: ['user_linus', 'user_mae', 'user_alan', SELF_ID],
    presence: [presence('user_linus', 'typing')]
  })

  it('caps at 3 avatars with +N, says roles and presence in words, and leaves you out', () => {
    render(
      <TooltipProvider>
        <CloudWorkspaceFollowers
          entries={entries}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following
          onToggleFollow={() => {}}
        />
      </TooltipProvider>
    )
    const people = screen.getAllByRole('button', { name: /·/ })
    expect(people.map((p) => p.getAttribute('aria-label'))).toEqual([
      'Grace Hopper · Created this workspace',
      'Linus Park · Following · Typing now',
      'Mae Jemison · Following'
    ])
    expect(screen.getByText('+1')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /Lovelace/ })).toBeNull()
  })

  it('offers Follow, and Following toggles back', () => {
    const toggle = vi.fn()
    const { rerender } = render(
      <TooltipProvider>
        <CloudWorkspaceFollowers
          entries={entries}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following={false}
          onToggleFollow={toggle}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }))
    expect(toggle).toHaveBeenCalledTimes(1)
    rerender(
      <TooltipProvider>
        <CloudWorkspaceFollowers
          entries={entries}
          directory={DIRECTORY}
          selfId={SELF_ID}
          following={null}
        />
      </TooltipProvider>
    )
    expect(screen.queryByRole('button', { name: 'Follow' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Following|Unfollow)/ })).toBeNull()
  })
})
