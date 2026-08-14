// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_TERMINAL_THEME_INHERIT } from '../../../../shared/agent-terminal-themes'
import { getAgentTerminalThemeOptions } from './agent-terminal-theme-options'
import { AgentTerminalThemesSection } from './AgentTerminalThemesSection'

const detectedAgentsMock = vi.hoisted(() => ({
  detectedIds: ['claude'] as TuiAgent[] | null,
  isLoading: false,
  detectionFailed: false,
  refresh: vi.fn(),
  lastTarget: undefined as unknown
}))

const storeMock = vi.hoisted(() => ({
  settingsSearchQuery: '',
  remoteDetectedAgentIds: {} as Record<string, TuiAgent[] | null>,
  runtimeDetectedAgentIds: {} as Record<string, TuiAgent[] | null>
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: (target: unknown) => {
    detectedAgentsMock.lastTarget = target
    return {
      detectedIds: detectedAgentsMock.detectedIds,
      isLoading: detectedAgentsMock.isLoading,
      detectionFailed: detectedAgentsMock.detectionFailed,
      isRefreshing: false,
      refresh: detectedAgentsMock.refresh
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock) => unknown) => selector(storeMock)
}))

function expandAgentThemes(rendered: ReturnType<typeof render>): void {
  fireEvent.click(rendered.getByRole('button', { name: /Agent terminal themes/ }))
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    theme: 'system',
    terminalUseSeparateLightTheme: false,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalThemeLight: 'Builtin Tango Light',
    terminalCustomThemes: [],
    disabledTuiAgents: [],
    agentTerminalThemes: {},
    ...overrides
  } as GlobalSettings
}

describe('getAgentTerminalThemeOptions', () => {
  it('prepends Inherit global with the inherit group', () => {
    const options = getAgentTerminalThemeOptions({ terminalCustomThemes: [] })

    expect(options[0]).toMatchObject({
      value: AGENT_TERMINAL_THEME_INHERIT,
      label: 'Inherit global',
      group: 'inherit',
      previewTheme: null
    })
    expect(options.some((option) => option.group === 'built-in')).toBe(true)
  })
})

describe('AgentTerminalThemesSection', () => {
  beforeEach(() => {
    detectedAgentsMock.detectedIds = ['claude']
    detectedAgentsMock.isLoading = false
    detectedAgentsMock.detectionFailed = false
    detectedAgentsMock.refresh.mockReset()
    detectedAgentsMock.lastTarget = undefined
    storeMock.remoteDetectedAgentIds = {}
    storeMock.runtimeDetectedAgentIds = {}
    storeMock.settingsSearchQuery = ''
  })

  afterEach(() => {
    cleanup()
  })

  it('stays collapsed by default and expands on click', () => {
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expect(rendered.getByRole('button', { name: /Agent terminal themes/ }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(rendered.queryByText('Claude')).toBeNull()
    expandAgentThemes(rendered)
    expect(rendered.getByRole('button', { name: /Agent terminal themes/ }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(rendered.getByText('Claude')).toBeTruthy()
  })

  it('expands when settings search matches the section', () => {
    storeMock.settingsSearchQuery = 'per-agent'
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expect(rendered.getByRole('button', { name: /Agent terminal themes/ }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(rendered.getByRole('button', { name: /Agent terminal themes/ })).toHaveProperty('disabled', true)
    expect(rendered.getByText('Claude')).toBeTruthy()
  })

  it('shows an override count on the collapsed row', () => {
    detectedAgentsMock.detectedIds = ['claude', 'codex']
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings({
          agentTerminalThemes: {
            claude: { dark: 'Ghostty Default Style Dark' },
            codex: { light: 'Builtin Tango Light' }
          }
        })}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expect(rendered.getByText('2 overrides')).toBeTruthy()
    expect(rendered.queryByText('Claude')).toBeNull()
    expandAgentThemes(rendered)
    expect(rendered.queryByText('2 overrides')).toBeNull()
    expect(rendered.getByText('Claude')).toBeTruthy()
  })

  it('probes local detection and lists unioned cached remote agents', () => {
    storeMock.remoteDetectedAgentIds = { 'ssh-1': ['codex'] }
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expect(detectedAgentsMock.lastTarget).toEqual({ kind: 'local' })
    expandAgentThemes(rendered)
    expect(rendered.getByText('Claude')).toBeTruthy()
    expect(rendered.getByText('Codex')).toBeTruthy()
    expect(rendered.queryByPlaceholderText('Search terminal themes')).toBeNull()
  })

  it('labels persisted disabled rows and expands a single picker', () => {
    const updateSettings = vi.fn()
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings({
          disabledTuiAgents: ['claude'],
          agentTerminalThemes: { claude: { dark: 'Ghostty Default Style Dark' } }
        })}
        updateSettings={updateSettings}
        target="dark"
      />
    )

    expect(rendered.getByText('1 override')).toBeTruthy()
    expandAgentThemes(rendered)
    expect(rendered.getByText(/Disabled/)).toBeTruthy()
    fireEvent.click(rendered.getByRole('button', { name: /Claude/ }))
    expect(rendered.getByPlaceholderText('Search terminal themes')).toBeTruthy()
    expect(rendered.getAllByText('Agent terminal themes')).toHaveLength(1)
    expect(
      rendered.getAllByText('Override the global terminal theme for a specific agent.')
    ).toHaveLength(1)
    expect(rendered.getByText(/Selected:\s*Ghostty Default Style Dark/)).toBeTruthy()
    fireEvent.click(rendered.getByRole('button', { name: 'Inherit global' }))
    expect(updateSettings).toHaveBeenCalledWith({
      agentTerminalThemes: {}
    })
  })

  it('shows detecting copy while local detection is in flight', () => {
    detectedAgentsMock.detectedIds = null
    detectedAgentsMock.isLoading = true
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expandAgentThemes(rendered)
    expect(rendered.getByText('Detecting agents…')).toBeTruthy()
  })

  it('shows a retryable failure when local detection finished empty', () => {
    detectedAgentsMock.detectedIds = null
    detectedAgentsMock.isLoading = false
    detectedAgentsMock.detectionFailed = true
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expandAgentThemes(rendered)
    expect(rendered.getByText(/Couldn’t detect installed agents/)).toBeTruthy()
    fireEvent.click(rendered.getByRole('button', { name: 'Retry' }))
    expect(detectedAgentsMock.refresh).toHaveBeenCalledOnce()
  })

  it('shows empty success copy when detection succeeded with no agents', () => {
    detectedAgentsMock.detectedIds = []
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings()}
        updateSettings={vi.fn()}
        target="dark"
      />
    )

    expandAgentThemes(rendered)
    expect(
      rendered.getByText('No enabled agents detected. Enable an agent in Settings → Agents.')
    ).toBeTruthy()
  })

  it('edits the light slot when the catalog target is light', () => {
    const updateSettings = vi.fn()
    const rendered = render(
      <AgentTerminalThemesSection
        settings={makeSettings({ terminalUseSeparateLightTheme: true })}
        updateSettings={updateSettings}
        target="light"
      />
    )

    expandAgentThemes(rendered)
    fireEvent.click(rendered.getByRole('button', { name: /Claude/ }))
    fireEvent.click(rendered.getByRole('button', { name: 'Builtin Tango Light' }))
    expect(updateSettings).toHaveBeenCalledWith({
      agentTerminalThemes: { claude: { light: 'Builtin Tango Light' } }
    })
  })
})
