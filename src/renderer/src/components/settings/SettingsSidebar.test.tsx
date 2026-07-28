// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bot, Mic, Network, Puzzle } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { SettingsSidebar } from './SettingsSidebar'
import { TooltipProvider } from '../ui/tooltip'
import type { SettingsSetupGuideProgress } from './settings-setup-guide-progress'
import type { GlobalSettings } from '../../../../shared/types'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { usePluginTerminalThemeStore } from '@/store/plugin-terminal-themes'

const mocks = vi.hoisted(() => ({
  useSettingsSetupGuideProgress: vi.fn()
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => '⌘F',
  useShortcutKeyComboDetails: () => [{ keys: ['⌘', 'F'], doubleTap: false }]
}))

vi.mock('./settings-setup-guide-progress', () => ({
  useSettingsSetupGuideProgress: mocks.useSettingsSetupGuideProgress
}))

function makeSetupGuideProgress(
  overrides: Partial<SettingsSetupGuideProgress> = {}
): SettingsSetupGuideProgress {
  return {
    ready: true,
    doneCount: 5,
    total: 8,
    firstIncompleteStepId: 'agent-capabilities',
    ...overrides
  }
}

function renderSidebar(
  activeSectionId = 'orchestration',
  settings: GlobalSettings = getDefaultSettings('/tmp')
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SettingsSidebar
        activeSectionId={activeSectionId}
        settings={settings}
        generalGroups={[
          {
            id: 'capabilities',
            title: 'AI Capabilities',
            sections: [
              {
                id: 'agents',
                title: 'Agents',
                icon: Bot
              },
              {
                id: 'orchestration',
                title: 'Orchestration',
                icon: Network,
                installStatus: 'install'
              },
              {
                id: 'voice',
                title: 'Voice',
                icon: Mic,
                installStatus: 'installed'
              },
              {
                id: 'computer-use',
                title: 'Computer Use',
                icon: Bot,
                installStatus: 'up-to-date'
              },
              {
                id: 'plugins',
                title: 'Plugins',
                icon: Puzzle
              }
            ]
          },
          {
            id: 'setup',
            title: 'Set Up',
            sections: [
              {
                id: 'accounts',
                title: 'AI Provider Accounts',
                icon: Bot,
                badge: 'Optional'
              }
            ]
          }
        ]}
        repoSections={[]}
        hasRepos={false}
        searchQuery=""
        onBack={vi.fn()}
        onSearchChange={vi.fn()}
        onSelectSection={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('SettingsSidebar', () => {
  beforeEach(() => {
    mocks.useSettingsSetupGuideProgress.mockReset()
    mocks.useSettingsSetupGuideProgress.mockReturnValue(makeSetupGuideProgress())
    usePluginIconThemeStore.setState({
      themes: [],
      activeId: null,
      activeTheme: null,
      loaded: true
    })
    usePluginTerminalThemeStore.setState({ themes: [], loaded: true })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('applies left sidebar appearance styles to the settings navigation', () => {
    const markup = renderSidebar('orchestration', {
      ...getDefaultSettings('/tmp'),
      leftSidebarAppearanceMode: 'match-terminal',
      terminalColorOverrides: {
        background: '#101820',
        foreground: '#f0f4f8'
      }
    })

    expect(markup).toContain('--worktree-sidebar:#101820')
    expect(markup).toContain('--worktree-sidebar-foreground:#f0f4f8')
  })

  it('renders install state labels separately from static badges', () => {
    const markup = renderSidebar()

    expect(markup).toContain('Not installed')
    expect(markup).toContain('Installed')
    expect(markup).toContain('Up to date')
    expect(markup).toContain('Optional')
  })

  it('does not render the setup guide row before progress readiness settles', () => {
    mocks.useSettingsSetupGuideProgress.mockReturnValue(
      makeSetupGuideProgress({
        ready: false,
        doneCount: 7,
        firstIncompleteStepId: 'setup-script'
      })
    )

    expect(renderSidebar()).not.toContain('Onboarding checklist')
  })

  it('renders incomplete setup progress with the full checklist total', () => {
    const markup = renderSidebar()

    expect(markup).toContain('Onboarding checklist')
    expect(markup).toContain('Onboarding checklist, 5 of 8 done. Show setup guide.')
    expect(markup).toContain('5 of 8 setup steps complete')
  })

  it('does not render the setup guide row after every checklist step is complete', () => {
    mocks.useSettingsSetupGuideProgress.mockReturnValue(
      makeSetupGuideProgress({
        doneCount: 8,
        firstIncompleteStepId: null
      })
    )

    expect(renderSidebar()).not.toContain('Onboarding checklist')
  })

  it('keeps the setup guide row available from Settings when incomplete', () => {
    const markup = renderSidebar('setup-guide')

    expect(markup).toContain('aria-current="page"')
    expect(markup).toContain('Onboarding checklist')
  })

  it('uses the plugin-specific settings navigation icon slot', async () => {
    const dataUrl = 'data:image/svg+xml;base64,cGx1Z2lucw=='
    usePluginIconThemeStore.setState({
      activeId: 'plugin:acme.icons/main',
      activeTheme: {
        id: 'plugin:acme.icons/main',
        pluginKey: 'acme.icons',
        label: 'Acme',
        icons: { 'sidebar.plugins': { dataUrl, rendering: 'image' } },
        fileNames: {},
        fileExtensions: {}
      }
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <SettingsSidebar
            activeSectionId="plugins"
            settings={getDefaultSettings('/tmp')}
            generalGroups={[
              {
                id: 'plugins',
                title: 'Extensions',
                sections: [{ id: 'plugins', title: 'Plugins', icon: Puzzle }]
              }
            ]}
            repoSections={[]}
            hasRepos={false}
            searchQuery=""
            onBack={vi.fn()}
            onSearchChange={vi.fn()}
            onSelectSection={vi.fn()}
          />
        </TooltipProvider>
      )
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(dataUrl)
    await act(async () => root.unmount())
  })

  it('reacts when a selected plugin terminal theme changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'dark' as const,
      leftSidebarAppearanceMode: 'match-terminal' as const,
      terminalThemeDark: 'plugin:acme.terminal/night',
      terminalThemeLight: 'plugin:acme.terminal/night'
    }

    await act(async () =>
      root.render(
        <TooltipProvider>
          <SettingsSidebar
            activeSectionId="plugins"
            settings={settings}
            generalGroups={[]}
            repoSections={[]}
            hasRepos={false}
            searchQuery=""
            onBack={vi.fn()}
            onSearchChange={vi.fn()}
            onSelectSection={vi.fn()}
          />
        </TooltipProvider>
      )
    )
    expect(container.querySelector('aside')?.getAttribute('style')).not.toContain('#123456')

    await act(async () =>
      usePluginTerminalThemeStore.setState({
        themes: [
          {
            id: 'plugin:acme.terminal/night',
            pluginKey: 'acme.terminal',
            label: 'Night',
            mode: 'dark',
            terminal: { background: '#123456', foreground: '#abcdef', black: '#000000' }
          }
        ],
        loaded: true
      })
    )

    expect(container.querySelector('aside')?.getAttribute('style')).toContain('#123456')
    await act(async () => root.unmount())
  })
})
