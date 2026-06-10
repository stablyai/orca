import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'

type Cleanup = () => void

type MockTerminalInstance = {
  options: Record<string, unknown>
  open: Mock
  write: Mock
  reset: Mock
  dispose: Mock
  loadAddon: Mock
}

type MockLigaturesAddonInstance = {
  dispose: Mock
}

const mockReactRuntime = vi.hoisted(() => ({
  cleanups: [] as Cleanup[],
  container: { nodeName: 'PREVIEW' },
  refCallIndex: 0
}))

const mockXterm = vi.hoisted(() => ({
  instances: [] as MockTerminalInstance[],
  nextLoadAddonError: null as Error | null,
  nextOpenError: null as Error | null
}))

const mockLigaturesAddon = vi.hoisted(() => ({
  enabled: false,
  instances: [] as MockLigaturesAddonInstance[]
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: (effect: () => void | Cleanup) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        mockReactRuntime.cleanups.push(cleanup)
      }
    },
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initialValue: unknown) => {
      const ref = { current: initialValue }
      if (mockReactRuntime.refCallIndex === 0) {
        ref.current = mockReactRuntime.container
      }
      mockReactRuntime.refCallIndex += 1
      return ref
    },
    useState: (initialValue: unknown) => [
      typeof initialValue === 'function' ? (initialValue as () => unknown)() : initialValue,
      vi.fn()
    ]
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class Terminal {
    options: Record<string, unknown>
    open: Mock
    write: Mock
    reset: Mock
    dispose: Mock
    loadAddon: Mock

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      this.open = vi.fn(() => {
        if (mockXterm.nextOpenError) {
          throw mockXterm.nextOpenError
        }
      })
      this.write = vi.fn()
      this.reset = vi.fn()
      this.dispose = vi.fn()
      this.loadAddon = vi.fn(() => {
        if (mockXterm.nextLoadAddonError) {
          throw mockXterm.nextLoadAddonError
        }
      })
      mockXterm.instances.push(this)
    }
  }
}))

vi.mock('@xterm/addon-ligatures', () => ({
  LigaturesAddon: class LigaturesAddon {
    dispose: Mock

    constructor() {
      this.dispose = vi.fn()
      mockLigaturesAddon.instances.push(this)
    }
  }
}))

vi.mock('@/components/ui/card', () => ({
  Card: 'Card',
  CardContent: 'CardContent',
  CardDescription: 'CardDescription',
  CardHeader: 'CardHeader',
  CardTitle: 'CardTitle'
}))

vi.mock('@/lib/pane-manager/pane-terminal-options', () => ({
  buildDefaultTerminalOptions: () => ({ scrollback: 0 })
}))

vi.mock('@/components/terminal-pane/layout-serialization', () => ({
  buildFontFamily: (font: string) => `built:${font}`
}))

vi.mock('@/components/terminal-pane/terminal-appearance', () => ({
  composeActiveTerminalTheme: () => ({ background: '#111111', foreground: '#eeeeee' })
}))

vi.mock('@/lib/terminal-theme', () => ({
  clampNumber: (value: number, min: number, max: number) => Math.max(min, Math.min(max, value)),
  resolveEffectiveTerminalAppearance: () => ({
    dividerColor: '#333333',
    theme: { background: '#000000' }
  })
}))

vi.mock('../../../../shared/terminal-fonts', () => ({
  resolveTerminalFontWeights: () => ({ fontWeight: 500, fontWeightBold: 700 })
}))

vi.mock('../../../../shared/terminal-ligatures', () => ({
  resolveTerminalLigaturesEnabled: () => mockLigaturesAddon.enabled
}))

import { TerminalSettingsPreview } from './TerminalSettingsPreview'

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    theme: 'dark',
    terminalFontFamily: 'SF Mono',
    terminalFontSize: 14,
    terminalFontWeight: 400,
    terminalLineHeight: 1,
    terminalCursorStyle: 'block',
    terminalCursorBlink: true,
    terminalLigatures: 'off',
    terminalThemeDark: 'Dark',
    terminalThemeLight: 'Light',
    terminalUseSeparateLightTheme: true,
    terminalDividerColorDark: '#333333',
    terminalDividerColorLight: '#dddddd',
    terminalColorOverrides: {},
    terminalBackgroundOpacity: 1,
    terminalCursorOpacity: 1,
    terminalDividerThicknessPx: 3,
    terminalInactivePaneOpacity: 0.6,
    ...overrides
  } as GlobalSettings
}

function renderPreview(settings = makeSettings()): void {
  TerminalSettingsPreview({
    title: 'Preview',
    description: 'Preview description',
    settings,
    systemPrefersDark: true
  })
}

function runCleanups(): void {
  for (const cleanup of [...mockReactRuntime.cleanups].reverse()) {
    cleanup()
  }
  mockReactRuntime.cleanups.length = 0
}

describe('TerminalSettingsPreview terminal lifecycle', () => {
  beforeEach(() => {
    mockReactRuntime.cleanups.length = 0
    mockReactRuntime.refCallIndex = 0
    mockXterm.instances.length = 0
    mockXterm.nextLoadAddonError = null
    mockXterm.nextOpenError = null
    mockLigaturesAddon.enabled = false
    mockLigaturesAddon.instances.length = 0
  })

  it('initializes once, writes once on mount, and disposes on unmount', () => {
    renderPreview()

    expect(mockXterm.instances).toHaveLength(1)
    const terminal = mockXterm.instances[0]
    expect(terminal.open).toHaveBeenCalledOnce()
    expect(terminal.open).toHaveBeenCalledWith(mockReactRuntime.container)
    expect(terminal.write).toHaveBeenCalledOnce()
    expect(terminal.reset).not.toHaveBeenCalled()
    expect(terminal.options).toMatchObject({
      allowTransparency: false,
      cols: 36,
      cursorBlink: true,
      cursorInactiveStyle: 'block',
      cursorStyle: 'block',
      disableStdin: true,
      fontFamily: 'built:SF Mono',
      fontSize: 14,
      fontWeight: 500,
      fontWeightBold: 700,
      lineHeight: 1,
      rows: 15,
      scrollback: 0,
      theme: { background: '#111111', foreground: '#eeeeee' }
    })

    runCleanups()
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })

  it('disposes the ligatures addon before disposing the terminal', () => {
    mockLigaturesAddon.enabled = true

    renderPreview()

    const terminal = mockXterm.instances[0]
    const addon = mockLigaturesAddon.instances[0]
    expect(terminal.loadAddon).toHaveBeenCalledOnce()
    expect(terminal.loadAddon).toHaveBeenCalledWith(addon)

    runCleanups()
    expect(addon.dispose).toHaveBeenCalledOnce()
    expect(terminal.dispose).toHaveBeenCalledOnce()
  })

  it('disposes the ligatures addon if loading it fails', () => {
    mockLigaturesAddon.enabled = true
    mockXterm.nextLoadAddonError = new Error('load addon failed')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      renderPreview()

      const addon = mockLigaturesAddon.instances[0]
      expect(addon.dispose).toHaveBeenCalledOnce()
      expect(mockXterm.instances[0].dispose).not.toHaveBeenCalled()

      runCleanups()
      expect(mockXterm.instances[0].dispose).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('disposes a partially created terminal if open fails', () => {
    const openError = new Error('open failed')
    mockXterm.nextOpenError = openError

    expect(() => renderPreview()).toThrow(openError)

    expect(mockXterm.instances).toHaveLength(1)
    expect(mockXterm.instances[0].dispose).toHaveBeenCalledOnce()
    expect(mockReactRuntime.cleanups).toHaveLength(0)
  })
})
