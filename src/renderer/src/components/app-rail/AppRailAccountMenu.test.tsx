// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  useHelpMenuController,
  type SetupMilestones
} from '@/components/sidebar/chrome/help-menu-controller'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'
import { AppRailAccountMenu, appRailAccount } from './AppRailAccountMenu'

const SIGNED_OUT: OrcaProfileAuthStatus = {
  activeProfileId: 'p1',
  configured: true,
  state: 'local',
  persistence: 'encrypted'
}
const SIGNED_IN: OrcaProfileAuthStatus = {
  ...SIGNED_OUT,
  state: 'connected',
  cloud: {
    cloudProfileId: 'c1',
    userId: 'u1',
    email: 'alex@example.com',
    displayName: 'Alex Chen',
    linkedAt: 1
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const noop = (): void => {}

function Harness({
  milestones = null,
  onOpenSettings = noop
}: {
  milestones?: SetupMilestones | null
  onOpenSettings?: () => void
}): React.JSX.Element {
  const help = useHelpMenuController(null)
  return (
    <TooltipProvider>
      <AppRailAccountMenu
        help={help}
        milestones={milestones}
        settingsActive={false}
        onOpenSettings={onOpenSettings}
        tabStop
      />
    </TooltipProvider>
  )
}

function openWithKey(button: HTMLElement, key: string): void {
  act(() => {
    button.focus()
    fireEvent.keyDown(button, { key })
  })
}

function menuRowLabels(): string[] {
  return screen.getAllByRole('menuitem').map((row) => row.textContent?.trim() ?? '')
}

describe('AppRailAccountMenu', () => {
  it('signed out: a Settings gear opening Sign in, Settings, then every Help row, with no Sign out', () => {
    useAppStore.setState({ orcaProfileAuthStatus: SIGNED_OUT })
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button.querySelector('svg')).not.toBeNull()
    openWithKey(button, 'Enter')
    const rows = menuRowLabels()
    expect(rows[0]).toBe('Sign in')
    expect(rows[1]).toMatch(/^Settings/)
    expect(rows[2]).toBe('Keyboard Shortcuts')
    expect(rows).toContain('Send Feedback')
    expect(rows.at(-1)).toBe('Restart Orca')
    expect(rows).not.toContain('Sign out')
    expect(rows).not.toContain('Milestones')
  })

  it('signed in: an initial avatar labelled Account, the name and email on top, Sign out last', () => {
    useAppStore.setState({ orcaProfileAuthStatus: SIGNED_IN })
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Account' })
    expect(button.textContent).toBe('A')
    openWithKey(button, 'ArrowDown')
    const menu = screen.getByRole('menu')
    expect(menu.textContent).toContain('Alex Chen')
    expect(menu.textContent).toContain('alex@example.com')
    const rows = menuRowLabels()
    expect(rows[0]).toMatch(/^Settings/)
    expect(rows).not.toContain('Sign in')
    expect(rows.at(-1)).toBe('Sign out')
  })

  it('setup unfinished: Milestones with its count opens the menu list, above Settings', () => {
    useAppStore.setState({ orcaProfileAuthStatus: SIGNED_IN })
    render(<Harness milestones={{ done: 3, total: 5 }} />)
    openWithKey(screen.getByRole('button', { name: 'Account' }), 'Enter')
    const rows = menuRowLabels()
    expect(rows[0]).toBe('Milestones3/5')
    expect(rows[1]).toMatch(/^Settings/)
    expect(rows.filter((row) => row.startsWith('Milestones'))).toHaveLength(1)
  })

  it('Settings opens the settings page; Escape returns focus to the button', async () => {
    useAppStore.setState({ orcaProfileAuthStatus: SIGNED_OUT })
    const onOpenSettings = vi.fn()
    render(<Harness onOpenSettings={onOpenSettings} />)
    const button = screen.getByRole('button', { name: 'Settings' })
    openWithKey(button, 'Enter')
    act(() => {
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    })
    expect(screen.queryByRole('menu')).toBeNull()
    // Radix hands focus back to the trigger in a timeout after the menu unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(button)
    openWithKey(button, 'Enter')
    const settingsRow = screen
      .getAllByRole('menuitem')
      .find((row) => row.textContent?.startsWith('Settings'))
    act(() => {
      fireEvent.click(settingsRow!)
    })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('hides Sign in in builds without Orca sign-in', () => {
    useAppStore.setState({ orcaProfileAuthStatus: { ...SIGNED_OUT, configured: false } })
    render(<Harness />)
    openWithKey(screen.getByRole('button', { name: 'Settings' }), 'Enter')
    expect(menuRowLabels()[0]).toMatch(/^Settings/)
  })
})

describe('appRailAccount', () => {
  it('prefers the display name, then the email, then the fallback', () => {
    const cloud = SIGNED_IN.cloud!
    expect(appRailAccount(cloud, 'Orca account')).toEqual({
      name: 'Alex Chen',
      email: 'alex@example.com',
      initial: 'A'
    })
    expect(appRailAccount({ ...cloud, displayName: '  ' }, 'Orca account').name).toBe(
      'alex@example.com'
    )
    expect(appRailAccount(undefined, 'Orca account')).toEqual({
      name: 'Orca account',
      email: undefined,
      initial: 'O'
    })
  })
})
