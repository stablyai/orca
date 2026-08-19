// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { i18n } from '@/i18n/i18n'
import { TooltipProvider } from '../ui/tooltip'
import { AppearanceBackgroundSection } from './AppearanceBackgroundSection'

const listLibrary = vi.fn()
const addImages = vi.fn()
const openLibrary = vi.fn()

function settingsWith(background: Record<string, unknown> = {}): GlobalSettings {
  return { ...getDefaultSettings('/tmp'), ...background } as GlobalSettings
}

function renderSection(
  settings: GlobalSettings = settingsWith(),
  updateSettings = vi.fn()
): ReturnType<typeof render> & { updateSettings: typeof updateSettings } {
  const result = render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <AppearanceBackgroundSection settings={settings} updateSettings={updateSettings} />
      </TooltipProvider>
    </I18nextProvider>
  )
  return { ...result, updateSettings }
}

describe('AppearanceBackgroundSection', () => {
  beforeEach(() => {
    listLibrary.mockResolvedValue({
      dir: '/backgrounds',
      images: [
        { fileName: 'left.png', path: '/backgrounds/left.png', size: 10 },
        { fileName: 'terminal.png', path: '/backgrounds/terminal.png', size: 20 }
      ]
    })
    addImages.mockResolvedValue({
      dir: '/backgrounds',
      images: [{ fileName: 'new.png', path: '/backgrounds/new.png', size: 30 }],
      added: ['new.png'],
      skipped: []
    })
    openLibrary.mockResolvedValue({ ok: true })
    ;(window as unknown as { api: unknown }).api = {
      backgrounds: { listLibrary, addImages, openLibrary }
    }
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as unknown as { api?: unknown }).api
  })

  it('selects a distinct image for each background area', async () => {
    const { updateSettings } = renderSection()
    await screen.findByRole('button', { name: 'left.png' })

    const target = screen.getByRole('radiogroup', { name: 'Background target' })
    fireEvent.click(target.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1])
    fireEvent.click(screen.getByRole('button', { name: 'left.png' }))

    expect(updateSettings).toHaveBeenCalledWith({
      orcaBackgroundByArea: { leftSidebar: 'left.png' },
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: false }
    })
  })

  it('resets opacity and blur only for the selected area', async () => {
    const { updateSettings } = renderSection(
      settingsWith({
        orcaBackgroundOpacityByArea: { terminal: 0.4, rightSidebar: 0.7 },
        orcaBackgroundBlurByArea: { terminal: 5, rightSidebar: 12 }
      })
    )
    await screen.findByRole('button', { name: 'left.png' })

    const target = screen.getByRole('radiogroup', { name: 'Background effects target' })
    fireEvent.click(target.querySelectorAll<HTMLButtonElement>('[role="radio"]')[2])
    fireEvent.click(screen.getByRole('button', { name: 'Reset background effects' }))

    expect(updateSettings).toHaveBeenCalledWith({
      orcaBackgroundOpacityByArea: { terminal: 0.4, rightSidebar: 1 },
      orcaBackgroundBlurByArea: { terminal: 5, rightSidebar: 0 }
    })
  })

  it('shows the selected thumbnail and cycles through the managed library', async () => {
    const { updateSettings } = renderSection(
      settingsWith({
        orcaBackgroundByArea: { terminal: 'left.png' },
        orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
      })
    )
    await screen.findByText('left.png', { selector: 'span' })

    fireEvent.click(screen.getByRole('button', { name: 'Next background image' }))

    expect(updateSettings).toHaveBeenCalledWith({
      orcaBackgroundByArea: { terminal: 'terminal.png' },
      orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
    })
  })

  it('adds an image to the active area and opens the managed folder', async () => {
    const { updateSettings } = renderSection()
    await screen.findByRole('button', { name: 'left.png' })

    fireEvent.click(screen.getByRole('button', { name: 'Add Image' }))
    await waitFor(() => expect(addImages).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        orcaBackgroundByArea: { terminal: 'new.png' },
        orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: false }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Backgrounds Folder' }))
    expect(openLibrary).toHaveBeenCalledOnce()
  })
})
