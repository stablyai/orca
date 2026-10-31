// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import * as customThemes from '../../../../shared/terminal-custom-themes'
import { useAppStore } from '@/store'
import { TerminalSurfacePreview } from './AgentDefaultSurfacePreviews'

function Preview(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  return settings ? <TerminalSurfacePreview settings={settings} /> : null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('still terminal appearance invalidation', () => {
  it.each([20, 200])('normalizes %i imported themes only when appearance changes', (count) => {
    const themes = Array.from({ length: count }, (_, index) => ({
      id: `warp:theme-${index}`,
      name: `Theme ${index}`,
      source: 'warp' as const,
      mode: 'dark' as const,
      terminal: { background: '#123456', foreground: '#abcdef', black: '#000000' },
      importedAt: '2026-06-05T00:00:00.000Z'
    }))
    const settings = createGlobalSettingsFixture({
      theme: 'dark',
      terminalThemeDark: 'custom:warp:theme-0',
      terminalCustomThemes: themes,
      terminalColorOverrides: { green: '#00ff00' },
      terminalBackgroundOpacity: 0.9,
      terminalPluginPalettes: [{ id: 'plugin:test', colors: { background: '#111111' } }]
    })
    const originalNormalize = customThemes.normalizeTerminalCustomThemes
    let themeVisits = 0
    const normalize = vi
      .spyOn(customThemes, 'normalizeTerminalCustomThemes')
      .mockImplementation((value) => {
        if (Array.isArray(value)) {
          themeVisits += value.length
        }
        return originalNormalize(value)
      })
    useAppStore.setState({ settings })
    const { container } = render(<Preview />)
    expect(normalize).toHaveBeenCalledTimes(1)
    expect(themeVisits).toBe(count)
    expect(container.querySelector('[style*="background"]')?.getAttribute('style')).toContain(
      '18, 52, 86'
    )
    normalize.mockClear()
    themeVisits = 0
    for (const agentDefaultSurface of ['chat', 'terminal'] as const) {
      act(() =>
        useAppStore.setState({
          settings: {
            ...structuredClone(settings),
            agentDefaultSurface
          }
        })
      )
      expect(normalize).not.toHaveBeenCalled()
      expect(themeVisits).toBe(0)
    }
    const changed = structuredClone(settings)
    changed.terminalCustomThemes![0].terminal.background = '#654321'
    act(() => useAppStore.setState({ settings: changed }))
    expect(normalize).toHaveBeenCalledTimes(1)
    expect(themeVisits).toBe(count)
    expect(container.querySelector('[style*="background"]')?.getAttribute('style')).toContain(
      '101, 67, 33'
    )
    act(() =>
      useAppStore.setState({
        settings: { ...changed, terminalColorOverrides: { foreground: '#ff0000' } }
      })
    )
    expect(container.querySelector('[style*="background"]')?.getAttribute('style')).toContain(
      '#ff0000'
    )
  })
})
