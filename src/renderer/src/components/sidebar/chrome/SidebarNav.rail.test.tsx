// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import SidebarNav from './SidebarNav'

const initialState = useAppStore.getState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

function renderNav(experimentalAppRail: boolean): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), experimentalAppRail, showMobileButton: false }
  })
  render(
    <TooltipProvider>
      <SidebarNav />
    </TooltipProvider>
  )
}

it('keeps the Tasks and Automations rows in the list with the app rail off', () => {
  renderNav(false)
  expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Automations' })).toBeInTheDocument()
})

it('leaves Tasks and Automations to the rail when it is on, keeping Search', () => {
  renderNav(true)
  expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()
  expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
})
