// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { ServerBrowserMemorySection } from './ServerBrowserMemorySection'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

type MemorySettings = Pick<GlobalSettings, 'serveBrowserPaintMode' | 'serveBrowserIdleSleepSeconds'>

function renderSection(
  settings: MemorySettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void = vi.fn(),
  flags = { showPaintMode: true, showIdleSleep: true }
): void {
  render(
    <TooltipProvider>
      <ServerBrowserMemorySection
        settings={settings}
        updateSettings={updateSettings}
        showPaintMode={flags.showPaintMode}
        showIdleSleep={flags.showIdleSleep}
      />
    </TooltipProvider>
  )
}

describe('ServerBrowserMemorySection', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders nothing when both rows are hidden', () => {
    const { container } = render(
      <TooltipProvider>
        <ServerBrowserMemorySection
          settings={{}}
          updateSettings={vi.fn()}
          showPaintMode={false}
          showIdleSleep={false}
        />
      </TooltipProvider>
    )
    expect(container.firstChild).toBeNull()
  })

  it('defaults the paint mode control to auto when unset', () => {
    renderSection({})
    const group = screen.getByRole('radiogroup', { name: 'Server tab rendering' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toContain('Auto')
  })

  it('binds serveBrowserPaintMode through updateSettings', () => {
    const updateSettings = vi.fn()
    renderSection({}, updateSettings)
    fireEvent.click(screen.getByRole('radio', { name: 'Always render' }))
    expect(updateSettings).toHaveBeenCalledWith({ serveBrowserPaintMode: 'always' })
  })

  it('defaults idle sleep to 10m when unset and binds values', () => {
    const updateSettings = vi.fn()
    renderSection({ serveBrowserIdleSleepSeconds: 600 }, updateSettings)
    const group = screen.getByRole('radiogroup', { name: 'Sleep idle server browser tabs' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe('10m')
    fireEvent.click(screen.getByRole('radio', { name: 'Never' }))
    expect(updateSettings).toHaveBeenCalledWith({ serveBrowserIdleSleepSeconds: 0 })
  })
})
