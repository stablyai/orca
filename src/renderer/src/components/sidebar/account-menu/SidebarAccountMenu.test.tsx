// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles'
import { registerAccountMenuItem } from './account-menu-items'
import { SidebarAccountMenu } from './SidebarAccountMenu'

vi.mock('../../setup-guide/use-setup-guide-progress', () => ({
  useSetupGuideProgress: () => ({ ready: false, coreDoneCount: 0, coreTotal: 0 })
}))

const initialState = useAppStore.getState()
const disposers: (() => void)[] = []

const connected: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'cp',
    userId: 'u',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    linkedAt: 0
  },
  capabilities: { flags: { 'team-admin': true }, refreshedAt: 0 }
}

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

function renderOpenMenu(): HTMLElement {
  render(
    <TooltipProvider>
      <SidebarAccountMenu />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Account' })
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse', ctrlKey: false })
  return trigger
}

it('groups the account header, Settings, and Help, and opens Settings', () => {
  const openSettingsPage = vi.fn()
  useAppStore.setState({ orcaProfileAuthStatus: connected, openSettingsPage })
  renderOpenMenu()

  expect(screen.getByRole('menuitem', { name: /Ada Lovelace/ })).toHaveTextContent(
    'ada@example.com'
  )
  expect(screen.getByRole('menuitem', { name: 'Help' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
  expect(openSettingsPage).toHaveBeenCalledTimes(1)
})

it('starts sign-in from the header when signed out', () => {
  const connectCurrentOrcaProfile = vi.fn(async () => null)
  useAppStore.setState({
    orcaProfileAuthStatus: {
      activeProfileId: 'local-default',
      configured: true,
      state: 'local',
      persistence: 'encrypted'
    },
    connectCurrentOrcaProfile
  })
  renderOpenMenu()

  fireEvent.click(screen.getByRole('menuitem', { name: /Sign in/ }))
  expect(connectCurrentOrcaProfile).toHaveBeenCalledTimes(1)
})

it('renders registered items only when their capability flag is on', () => {
  const onSelect = vi.fn()
  disposers.push(
    registerAccountMenuItem({
      id: 'gated',
      label: () => 'Gated item',
      requiredCapability: 'team-admin',
      onSelect
    }),
    registerAccountMenuItem({
      id: 'hidden',
      label: () => 'Hidden item',
      requiredCapability: 'not-granted',
      onSelect: vi.fn()
    })
  )
  useAppStore.setState({ orcaProfileAuthStatus: connected })
  renderOpenMenu()

  expect(screen.queryByRole('menuitem', { name: 'Hidden item' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Gated item' }))
  expect(onSelect).toHaveBeenCalledTimes(1)
})

it('hides capability-gated items while signed out', () => {
  disposers.push(
    registerAccountMenuItem({
      id: 'gated',
      label: () => 'Gated item',
      requiredCapability: 'team-admin',
      onSelect: vi.fn()
    })
  )
  useAppStore.setState({
    orcaProfileAuthStatus: { ...connected, state: 'reconnect-required' }
  })
  renderOpenMenu()

  expect(screen.getByRole('menuitem', { name: /Sign in again/ })).toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Gated item' })).not.toBeInTheDocument()
})
