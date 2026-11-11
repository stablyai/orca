// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TeammateProfile } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TeammateProfileView, type TeammateProfileViewProps } from './TeammateProfileView'

afterEach(cleanup)

const profile = (overrides: Partial<TeammateProfile> = {}): TeammateProfile => ({
  userId: 'u-grace',
  self: false,
  name: 'Grace Hopper',
  usage: { start: '2026-11-04', levels: [0, 2, 4, 1, 0, 0, 3], activeDays: 4, own: null },
  recentWorkspaces: [],
  pokes: { enabled: true, teammateEnabled: true },
  ...overrides
})

function view(props: Partial<TeammateProfileViewProps> = {}) {
  const handlers = { onPoke: vi.fn(), onTurnOnPokes: vi.fn() }
  render(
    <TooltipProvider>
      <TeammateProfileView
        userId="u-grace"
        name="Grace Hopper"
        email="grace@acme.dev"
        role="admin"
        profile={profile()}
        error={null}
        poke={{ kind: 'idle' }}
        now={Date.UTC(2026, 10, 10)}
        onRetry={() => {}}
        onOpenWorkspace={() => {}}
        onShowAllWorkspaces={() => {}}
        {...handlers}
        {...props}
      />
    </TooltipProvider>
  )
  return handlers
}

it('pokes when both people have Pokes on, and summarizes the heatmap without amounts', () => {
  const { onPoke } = view()
  fireEvent.click(screen.getByRole('button', { name: /Poke/ }))
  expect(onPoke).toHaveBeenCalledOnce()
  expect(
    screen.getByRole('img', { name: 'Grace Hopper used Orca Cloud on 4 of the last 7 days' })
  ).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/sandbox hour|\$/)
})

it('sends you to Settings when your Pokes are off, and disables Poke when theirs are', () => {
  const { onTurnOnPokes } = view({
    profile: profile({ pokes: { enabled: false, teammateEnabled: null } })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
  expect(onTurnOnPokes).toHaveBeenCalledOnce()
  cleanup()
  const { onPoke } = view({
    profile: profile({ pokes: { enabled: true, teammateEnabled: false } })
  })
  expect(screen.getByText('Grace Hopper hasn’t turned on Pokes yet.')).toBeTruthy()
  const poke = screen.getByRole('button', { name: /Poke/ })
  // Muted and explained, but still focusable; a click does nothing.
  expect(poke.getAttribute('aria-disabled')).toBe('true')
  expect(poke.hasAttribute('disabled')).toBe(false)
  expect(poke.getAttribute('aria-describedby')).toBeTruthy()
  fireEvent.click(poke)
  expect(onPoke).not.toHaveBeenCalled()
})

it('says when a teammate has not shared their activity', () => {
  view({ profile: profile({ usage: null, pokes: { enabled: true, teammateEnabled: false } }) })
  expect(screen.getByText('Grace Hopper hasn’t shared their activity.')).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})

it('shows no Poke on your own profile', () => {
  view({ profile: profile({ self: true, pokes: { enabled: true, teammateEnabled: null } }) })
  expect(screen.queryByRole('button', { name: /Poke/ })).toBeNull()
})
