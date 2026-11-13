// @vitest-environment happy-dom
// Landing's Add project is the sidebar's Add project menu (not the old modal), and both carry
// "Open cloud workspace…" while signed in to Orca Cloud.
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { LandingAddProjectMenu } from './LandingAddProjectMenu'
import { SidebarHeaderActions } from '../sidebar/sidebar-header-actions'
import {
  closeCloudWorkspacePicker,
  getCloudWorkspacePickerRequest
} from '../cloud-workspaces/cloud-workspace-picker-store'

const cloud = vi.hoisted(() => ({ present: true }))
vi.mock('@/components/cloud-workspaces/use-cloud-workspaces', () => ({
  useCloudWorkspacesPresent: () => cloud.present
}))
vi.mock('@/components/sidebar/host-admission/ssh/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

const initialState = useAppStore.getState()

beforeEach(() => {
  cloud.present = true
  useAppStore.setState({
    activeModal: 'none',
    modalData: {},
    settings: getDefaultSettings('/tmp/orca-test')
  })
})

afterEach(() => {
  cleanup()
  closeCloudWorkspacePicker()
  useAppStore.setState(initialState, true)
})

function renderLanding(): void {
  render(
    <TooltipProvider>
      <LandingAddProjectMenu>
        <button type="button">Add project</button>
      </LandingAddProjectMenu>
    </TooltipProvider>
  )
}

describe('Landing Add project', () => {
  it('opens the Add project menu, not the old add-project modal', async () => {
    const user = userEvent.setup()
    renderLanding()
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect(await screen.findByRole('menuitem', { name: /Browse folder/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Create new project/ })).toBeTruthy()
    expect(useAppStore.getState().activeModal).toBe('none')

    await user.click(screen.getByRole('menuitem', { name: /Clone from URL/ }))
    expect(useAppStore.getState().activeModal).toBe('add-repo')
    expect(useAppStore.getState().modalData.entryRequest).toMatchObject({ kind: 'clone' })
  })

  it('with Orca Cloud, "Open cloud workspace…" opens the picker', async () => {
    const user = userEvent.setup()
    renderLanding()
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Open cloud workspace…' }))
    expect(getCloudWorkspacePickerRequest()?.focus).toEqual({ kind: 'open' })
  })

  it('without Orca Cloud, the menu has no cloud entry', async () => {
    cloud.present = false
    const user = userEvent.setup()
    renderLanding()
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await screen.findByRole('menuitem', { name: /Browse folder/ })
    expect(screen.queryByRole('menuitem', { name: 'Open cloud workspace…' })).toBeNull()
  })
})

describe('sidebar Add project', () => {
  it('carries the same "Open cloud workspace…" entry', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={vi.fn()} />
      </TooltipProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Open cloud workspace…' }))
    expect(getCloudWorkspacePickerRequest()?.focus).toEqual({ kind: 'open' })
  })
})
