// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AppearanceChromeMock } from './appearance-chrome-mock'

describe('AppearanceChromeMock', () => {
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()
  const loadImage = vi.fn()

  beforeEach(() => {
    createObjectURL.mockReset()
    revokeObjectURL.mockReset()
    loadImage.mockReset()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    ;(window as unknown as { api: unknown }).api = { backgrounds: { loadImage } }
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { api?: unknown }).api
  })

  it('reflects drafted font, sidebar, card, navigation, and status settings', () => {
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      appFontFamily: 'IBM Plex Sans',
      compactWorktreeCards: true,
      leftSidebarAppearanceMode: 'tinted' as const,
      leftSidebarTintColor: '#123456',
      leftSidebarTintOpacity: 0.25,
      showAutomationsButton: false,
      showMobileButton: true,
      showTasksButton: true,
      showTitlebarAppName: false
    }

    render(
      <AppearanceChromeMock
        settings={settings}
        systemPrefersDark={false}
        statusBarItems={['codex', 'ssh', 'ports']}
      />
    )

    const preview = screen.getByRole('img', {
      name: 'Orca interface preview. Status bar: Codex, SSH, Ports'
    })
    expect(preview.style.getPropertyValue('--app-font-family')).toContain('"IBM Plex Sans"')
    expect(preview.getAttribute('style')).toContain('font-family: var(--app-font-family)')

    const sidebar = preview.querySelector<HTMLElement>('[data-left-sidebar-appearance="tinted"]')
    expect(sidebar?.style.getPropertyValue('--worktree-sidebar')).toBe(
      'color-mix(in srgb, #123456 25%, var(--background))'
    )
    expect(preview.querySelector('[data-workspace-card-layout="compact"]')).not.toBeNull()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('Mobile')).toBeInTheDocument()
    expect(screen.queryByText('Automations')).not.toBeInTheDocument()
    expect(screen.queryByText('feature/preview')).not.toBeInTheDocument()
    expect(preview.querySelector('[data-titlebar-app-name-visible="false"]')).not.toBeNull()

    for (const item of ['codex', 'ssh', 'ports']) {
      expect(preview.querySelector(`[data-status-bar-item="${item}"]`)).not.toBeNull()
    }
  })

  it('labels an empty-status detailed preview and exposes its visible chrome', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      compactWorktreeCards: false,
      showAutomationsButton: false,
      showMobileButton: false,
      showTasksButton: false,
      showTitlebarAppName: true
    }

    render(
      <AppearanceChromeMock settings={settings} systemPrefersDark={false} statusBarItems={[]} />
    )

    const preview = screen.getByRole('img', { name: 'Orca interface preview' })
    expect(preview.querySelector('[data-workspace-card-layout="detailed"]')).not.toBeNull()
    expect(preview.querySelector('[data-titlebar-app-name-visible="true"]')).not.toBeNull()
    expect(screen.getByText('Orca')).toBeInTheDocument()
    expect(screen.getByText('feature/preview')).toBeInTheDocument()
    expect(screen.getByText('1 terminal')).toBeInTheDocument()
    expect(preview.querySelector('[data-status-bar-item]')).toBeNull()
  })

  it('renders independent draft images inside the left and right sidebar previews', async () => {
    loadImage.mockResolvedValue({
      ok: true,
      data: new Uint8Array([1]),
      mimeType: 'image/png'
    })
    createObjectURL.mockReturnValueOnce('blob:left').mockReturnValueOnce('blob:right')
    const settings: GlobalSettings = {
      ...getDefaultSettings('/tmp'),
      orcaBackgroundByArea: {
        terminal: 'terminal.png',
        leftSidebar: 'left.png',
        rightSidebar: 'right.png'
      },
      orcaBackgroundAreas: { terminal: true, leftSidebar: true, rightSidebar: true },
      orcaBackgroundOpacity: 0.4,
      orcaBackgroundOpacityByArea: { leftSidebar: 0.2, rightSidebar: 0.8 },
      orcaBackgroundBlur: 6,
      orcaBackgroundBlurByArea: { leftSidebar: 4, rightSidebar: 20 },
      orcaBackgroundFit: 'contain'
    }
    const { rerender } = render(
      <AppearanceChromeMock settings={settings} systemPrefersDark={false} statusBarItems={[]} />
    )

    await waitFor(() =>
      expect(document.querySelectorAll('[data-appearance-preview-background]')).toHaveLength(2)
    )

    const leftArea = document.querySelector<HTMLElement>('[data-preview-area="left-sidebar"]')
    const rightArea = document.querySelector<HTMLElement>('[data-preview-area="right-sidebar"]')
    const leftLayer = leftArea?.querySelector<HTMLElement>(
      '[data-appearance-preview-background="left-sidebar"]'
    )
    const rightLayer = rightArea?.querySelector<HTMLElement>(
      '[data-appearance-preview-background="right-sidebar"]'
    )
    expect(leftLayer).toHaveAttribute('data-background-file-name', 'left.png')
    expect(rightLayer).toHaveAttribute('data-background-file-name', 'right.png')
    expect(leftLayer).toHaveStyle({
      backgroundImage: 'url("blob:left")',
      backgroundSize: 'contain',
      filter: 'blur(4px)',
      opacity: '0.2'
    })
    expect(rightLayer).toHaveStyle({
      backgroundImage: 'url("blob:right")',
      filter: 'blur(20px)',
      opacity: '0.8'
    })
    expect(screen.getByText('Explorer')).toBeInTheDocument()
    expect(loadImage).toHaveBeenCalledWith('left.png')
    expect(loadImage).toHaveBeenCalledWith('right.png')

    rerender(
      <AppearanceChromeMock
        settings={
          {
            ...settings,
            orcaBackgroundOpacityByArea: { leftSidebar: 0.5, rightSidebar: 0.8 },
            orcaBackgroundBlurByArea: { leftSidebar: 10, rightSidebar: 20 }
          } as typeof settings
        }
        systemPrefersDark={false}
        statusBarItems={[]}
      />
    )

    expect(leftLayer).toHaveStyle({ filter: 'blur(10px)', opacity: '0.5' })
    expect(rightLayer).toHaveStyle({ filter: 'blur(20px)', opacity: '0.8' })
    expect(loadImage).toHaveBeenCalledTimes(2)

    rerender(
      <AppearanceChromeMock
        settings={
          {
            ...settings,
            orcaBackgroundAreas: { terminal: true, leftSidebar: false, rightSidebar: true }
          } as typeof settings
        }
        systemPrefersDark={false}
        statusBarItems={[]}
      />
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-appearance-preview-background="left-sidebar"]')
      ).toBeNull()
    )
    expect(
      document.querySelector('[data-appearance-preview-background="right-sidebar"]')
    ).not.toBeNull()
  })
})
