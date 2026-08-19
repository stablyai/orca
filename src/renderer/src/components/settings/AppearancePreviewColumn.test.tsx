// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

const mocks = vi.hoisted(() => ({
  state: {
    statusBarItems: [] as StatusBarItem[]
  },
  terminalRender: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('./TerminalSettingsPreview', () => ({
  TerminalSettingsPreview: (props: {
    description: string
    modeOverride?: 'dark' | 'light'
    onModeOverrideChange?: (mode: 'dark' | 'light') => void
    previewFontFamily?: string | null
    settings: GlobalSettings
    showThemeToggle?: boolean
    systemPrefersDark: boolean
    title: string
  }) => {
    mocks.terminalRender(props)
    return <div data-testid="terminal-preview" data-settings-theme={props.settings.theme} />
  }
}))

import { getDefaultSettings } from '../../../../shared/constants'
import { AppearancePreviewColumn } from './AppearancePreviewColumn'

const onTerminalPreviewModeChange = vi.fn()

function renderPreviewColumn(
  settings: GlobalSettings,
  systemPrefersDark: boolean
): ReturnType<typeof render> {
  return render(
    <AppearancePreviewColumn
      settings={settings}
      systemPrefersDark={systemPrefersDark}
      previewFontFamily="JetBrains Mono"
      terminalPreviewMode="dark"
      onTerminalPreviewModeChange={onTerminalPreviewModeChange}
    />
  )
}

describe('AppearancePreviewColumn', () => {
  beforeEach(() => {
    mocks.state.statusBarItems = []
    mocks.terminalRender.mockClear()
    onTerminalPreviewModeChange.mockClear()
    document.documentElement.className = ''
  })

  afterEach(() => {
    cleanup()
    document.documentElement.className = ''
  })

  it('scopes the drafted theme without changing the active document theme', () => {
    document.documentElement.className = 'theme-light'
    const settings = { ...getDefaultSettings('/tmp'), theme: 'dark' as const }

    renderPreviewColumn(settings, false)

    const previewColumn = screen.getByRole('complementary', { name: 'Appearance preview' })
    expect(previewColumn).toHaveClass('order-first', 'lg:order-none', 'lg:sticky')
    expect(screen.getByText('Live preview')).toBeInTheDocument()
    expect(screen.getByText('Updates as you edit.')).toBeInTheDocument()
    const themeBoundary = previewColumn.querySelector<HTMLElement>('[data-preview-theme="dark"]')
    expect(themeBoundary).toHaveClass('dark')
    expect(themeBoundary).not.toHaveClass('theme-light')
    expect(document.documentElement).toHaveClass('theme-light')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(screen.getByTestId('terminal-preview')).toHaveAttribute('data-settings-theme', 'dark')
    expect(mocks.terminalRender).toHaveBeenCalledWith(
      expect.objectContaining({
        settings,
        modeOverride: 'dark',
        onModeOverrideChange: onTerminalPreviewModeChange,
        previewFontFamily: 'JetBrains Mono',
        showThemeToggle: true,
        systemPrefersDark: false
      })
    )
  })

  it('resolves a drafted system theme from the current system preference', () => {
    const settings = { ...getDefaultSettings('/tmp'), theme: 'system' as const }
    const { rerender } = renderPreviewColumn(settings, false)

    expect(document.querySelector('[data-preview-theme="light"]')).toHaveClass('theme-light')

    rerender(
      <AppearancePreviewColumn
        settings={settings}
        systemPrefersDark
        terminalPreviewMode="dark"
        onTerminalPreviewModeChange={onTerminalPreviewModeChange}
      />
    )

    expect(document.querySelector('[data-preview-theme="dark"]')).toHaveClass('dark')
  })

  it('labels the preview column and reflects status items from the app store', () => {
    mocks.state.statusBarItems = ['codex', 'resource-usage']

    renderPreviewColumn(getDefaultSettings('/tmp'), false)

    expect(screen.getByRole('complementary', { name: 'Appearance preview' })).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: 'Orca interface preview. Status bar: Codex, Resource usage'
      })
    ).toBeInTheDocument()
    expect(document.querySelector('[data-status-bar-item="codex"]')).not.toBeNull()
    expect(document.querySelector('[data-status-bar-item="resource-usage"]')).not.toBeNull()
  })
})
