import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getBuiltinTheme } from '@/lib/terminal-theme'
import { getDefaultSettings } from '../../../../shared/constants'
import type { RepoTerminalThemeOverrides } from '../../../../shared/repo-terminal-theme'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { applyTerminalAppearance, composeActiveTerminalTheme } from './terminal-appearance'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'

function makePane(id: number): ManagedPane {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the pane members exercised by appearance logic.
  return {
    id,
    terminal: { options: {}, cols: 80, rows: 24 },
    container: {
      dataset: {},
      getBoundingClientRect: () => ({ width: 800, height: 600 })
    },
    fitAddon: { proposeDimensions: () => ({ cols: 80, rows: 24 }) }
  } as unknown as ManagedPane
}

function makeManager(panes: ManagedPane[]): PaneManager {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members exercised by appearance logic.
  return {
    getPanes: () => panes.map((pane) => ({ ...pane })),
    setPaneLigaturesEnabled: vi.fn(),
    setPaneInlineImagesEnabled: vi.fn(),
    setPaneStyleOptions: vi.fn()
  } as unknown as PaneManager
}

function darkSettings(): ReturnType<typeof getDefaultSettings> {
  return { ...getDefaultSettings('/tmp'), theme: 'dark' }
}

function apply(
  pane: ManagedPane,
  settings: ReturnType<typeof getDefaultSettings>,
  repoTerminalTheme?: RepoTerminalThemeOverrides
): void {
  applyTerminalAppearance(
    makeManager([pane]),
    settings,
    true,
    new Map(),
    new Map(),
    'false',
    new Map(),
    new Map(),
    repoTerminalTheme
  )
}

function composedBackground(
  themeName: string,
  settings: ReturnType<typeof getDefaultSettings>
): string | undefined {
  return composeActiveTerminalTheme(getBuiltinTheme(themeName), settings)?.background
}

describe('applyTerminalAppearance repo terminal theme override', () => {
  let publishMock: ReturnType<typeof vi.fn<(attributes: TerminalViewAttributes) => void>>

  beforeEach(() => {
    _resetTerminalViewAttributesPublisherForTest()
    publishMock = vi.fn<(attributes: TerminalViewAttributes) => void>()
    vi.stubGlobal('window', {
      api: { pty: { publishTerminalViewAttributes: publishMock } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    _resetTerminalViewAttributesPublisherForTest()
  })

  it('writes the repo dark override into the pane xterm theme', () => {
    const settings = darkSettings()
    const pane = makePane(1)
    apply(pane, settings, { dark: 'Dracula' })
    expect(pane.terminal.options.theme?.background).toBe(composedBackground('Dracula', settings))
    expect(pane.terminal.options.theme?.background).not.toBe(
      composedBackground(settings.terminalThemeDark, settings)
    )
  })

  it('publishes view attributes from the global theme, not the repo override', () => {
    const settings = darkSettings()
    apply(makePane(1), settings)
    const globalAttributes = publishMock.mock.calls[0]?.[0]
    expect(globalAttributes).toBeDefined()

    _resetTerminalViewAttributesPublisherForTest()
    publishMock.mockClear()
    apply(makePane(2), settings, { dark: 'Dracula' })
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock.mock.calls[0]?.[0]?.background).toEqual(globalAttributes?.background)
    expect(publishMock.mock.calls[0]?.[0]?.background).not.toEqual([0x28, 0x2a, 0x36])
  })

  it('publishes only the app-global snapshot from panes, whatever their repo override', () => {
    const settings = darkSettings()
    apply(makePane(1), settings, { dark: 'Dracula' })
    apply(makePane(2), settings, { dark: 'Nord' })
    apply(makePane(3), settings)
    apply(makePane(4), settings, { dark: 'Dracula' })
    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  it('matches the global-only behavior when no override is set', () => {
    const settings = darkSettings()
    const withoutArg = makePane(1)
    const withUndefined = makePane(2)
    apply(withoutArg, settings)
    apply(withUndefined, settings, undefined)
    expect(withoutArg.terminal.options.theme).toEqual(withUndefined.terminal.options.theme)
    expect(withoutArg.terminal.options.theme?.background).toBe(
      composedBackground(settings.terminalThemeDark, settings)
    )
  })

  it('re-writes options.theme when the repo override changes', () => {
    const settings = darkSettings()
    const pane = makePane(1)
    apply(pane, settings, { dark: 'Dracula' })
    const first = pane.terminal.options.theme
    apply(pane, settings, { dark: 'Nord' })
    expect(pane.terminal.options.theme).not.toBe(first)
    expect(pane.terminal.options.theme?.background).toBe(composedBackground('Nord', settings))
  })

  it('falls back to the global theme for an unresolvable override', () => {
    const settings = darkSettings()
    const pane = makePane(1)
    apply(pane, settings, { dark: 'custom:ghostty:deleted' })
    expect(pane.terminal.options.theme?.background).toBe(
      composedBackground(settings.terminalThemeDark, settings)
    )
  })

  it('value-gates an identical repo override', () => {
    const settings = darkSettings()
    const pane = makePane(1)
    apply(pane, settings, { dark: 'Dracula' })
    const first = pane.terminal.options.theme
    apply(pane, settings, { dark: 'Dracula' })
    expect(pane.terminal.options.theme).toBe(first)
  })
})
