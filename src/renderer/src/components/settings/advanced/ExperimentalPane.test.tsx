// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useAppStore } from '@/store'
import { TooltipProvider } from '../../ui/tooltip'
import { ExperimentalPane } from './ExperimentalPane'

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))
afterEach(cleanup)

it('opens the ordinary Experimental pane and preserves its setting action', () => {
  const updateSettings = vi.fn()
  render(
    <TooltipProvider>
      <ExperimentalPane
        settings={{ ...getDefaultSettings('/tmp'), experimentalPet: false }}
        updateSettings={updateSettings}
      />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole('switch', { name: 'Pet' }))
  expect(updateSettings).toHaveBeenCalledWith({ experimentalPet: true })
})
