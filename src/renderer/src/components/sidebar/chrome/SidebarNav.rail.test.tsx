// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { _resetPairedMobileDevicesCacheForTests } from '@/components/mobile/paired-mobile-devices'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import SidebarNav from './SidebarNav'

const initialState = useAppStore.getState()
const listDevices = vi.fn(async () => ({ devices: [] }))

beforeEach(() => {
  _resetPairedMobileDevicesCacheForTests()
  listDevices.mockClear()
  vi.stubGlobal('api', { ...window.api, mobile: { ...window.api?.mobile, listDevices } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

function setAppRail(experimentalAppRail: boolean): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/home/test'),
      experimentalAppRail,
      showArtifactsButton: true,
      showSkillsButton: true,
      showMobileButton: true
    }
  })
}

function renderNav(): void {
  render(
    <TooltipProvider>
      <SidebarNav />
    </TooltipProvider>
  )
}

const RAIL_ROWS = ['Tasks', 'Automations', 'Artifacts', 'Skills', /Orca Mobile/]

it('hands Tasks, Automations, Artifacts, Skills and Orca Mobile to the rail when enabled and keeps Search', () => {
  setAppRail(false)
  renderNav()
  for (const name of RAIL_ROWS) {
    expect(screen.getByRole('button', { name })).toBeInTheDocument()
  }

  act(() => setAppRail(true))
  for (const name of RAIL_ROWS) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
})

it("asks for paired devices for Orca Mobile's New badge only while the list shows the Mobile row", async () => {
  setAppRail(true)
  renderNav()
  await act(() => Promise.resolve())
  expect(listDevices).not.toHaveBeenCalled()
  cleanup()

  setAppRail(false)
  renderNav()
  expect(await screen.findByText('New')).toBeInTheDocument()
  expect(listDevices).toHaveBeenCalled()
})
