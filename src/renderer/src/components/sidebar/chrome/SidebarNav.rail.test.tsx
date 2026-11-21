// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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

function setAppRail(experimentalAppRail: boolean): void {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), experimentalAppRail, showMobileButton: false }
  })
}

it('hands Tasks and Automations to the rail when enabled and keeps Search', () => {
  setAppRail(false)
  render(
    <TooltipProvider>
      <SidebarNav />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Automations' })).toBeInTheDocument()

  act(() => setAppRail(true))
  expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()
  expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
})
