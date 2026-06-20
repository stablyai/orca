import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import {
  MAX_TERMINAL_CUSTOM_THEMES,
  type WarpThemeImportPreview
} from '../../../../shared/terminal-custom-themes'

const mockStateValues: unknown[] = []
let mockStateIndex = 0

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (msg: string) => toastSuccess(msg) } }))

const baseSettings: GlobalSettings = {
  terminalCustomThemes: [
    {
      id: 'warp:existing',
      name: 'Existing',
      source: 'warp',
      mode: 'dark',
      terminal: { background: '#000000', foreground: '#ffffff', black: '#111111' },
      importedAt: '2026-06-01T00:00:00.000Z'
    }
  ]
} as GlobalSettings

function resetMockState() {
  mockStateIndex = 0
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      void effect()
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const i = mockStateIndex++
      if (mockStateValues[i] === undefined) {
        mockStateValues[i] = typeof initial === 'function' ? initial() : initial
      }
      const setter = (v: unknown) => {
        mockStateValues[i] = typeof v === 'function' ? v(mockStateValues[i]) : v
      }
      return [mockStateValues[i], setter]
    }
  }
})

import { useWarpThemeImport } from './useWarpThemeImport'

describe('useWarpThemeImport', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    resetMockState()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not preview Warp themes on mount', () => {
    const previewMock = vi.fn()
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    useWarpThemeImport(vi.fn(), baseSettings)

    expect(previewMock).not.toHaveBeenCalled()
  })

  it('previews on click and merges selected themes into settings', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      sourceLabel: 'themes',
      skippedFiles: [],
      themes: [
        {
          id: 'warp:tokyo-night',
          selectionValue: 'custom:warp:tokyo-night',
          name: 'Tokyo Night',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#1a1b26', foreground: '#c0caf5', black: '#15161e' },
          importedAt: '2026-06-05T00:00:00.000Z',
          sourceLabel: 'themes'
        }
      ]
    }
    const previewMock = vi.fn().mockResolvedValue(previewResponse)
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })
    const updateSettings = vi.fn()

    let warp = useWarpThemeImport(updateSettings, baseSettings)
    await warp.handleClick()
    expect(previewMock).toHaveBeenCalledWith({ kind: 'auto' })

    resetMockState()
    warp = useWarpThemeImport(updateSettings, baseSettings)
    expect(warp.open).toBe(true)
    expect(warp.selectedThemeIds.has('warp:tokyo-night')).toBe(true)

    await warp.handleApply()

    expect(updateSettings).toHaveBeenCalledWith({
      terminalCustomThemes: [
        expect.objectContaining({ id: 'warp:existing' }),
        expect.objectContaining({ id: 'warp:tokyo-night', name: 'Tokyo Night' })
      ]
    })
    // Success is reported via a toast, and the modal closes itself.
    expect(toastSuccess).toHaveBeenCalledWith('Imported 1 theme')

    resetMockState()
    warp = useWarpThemeImport(updateSettings, baseSettings)
    expect(warp.open).toBe(false)
  })

  it('does not apply when no themes are selected', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      themes: [
        {
          id: 'warp:tokyo-night',
          selectionValue: 'custom:warp:tokyo-night',
          name: 'Tokyo Night',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#1a1b26', foreground: '#c0caf5', black: '#15161e' },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ],
      skippedFiles: []
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })
    const updateSettings = vi.fn()

    let warp = useWarpThemeImport(updateSettings, baseSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(updateSettings, baseSettings)
    warp.handleToggleAll(false)
    resetMockState()
    warp = useWarpThemeImport(updateSettings, baseSettings)
    await warp.handleApply()

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('toggles every previewed theme id when selecting all', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      themes: [
        {
          id: 'warp:one',
          selectionValue: 'custom:warp:one',
          name: 'One',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#000000', foreground: '#ffffff', black: '#111111' },
          importedAt: '2026-06-05T00:00:00.000Z'
        },
        {
          id: 'warp:two',
          selectionValue: 'custom:warp:two',
          name: 'Two',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#000000', foreground: '#ffffff', black: '#222222' },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ],
      skippedFiles: []
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    warp.handleToggleAll(false)
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)

    expect(warp.selectedThemeIds.size).toBe(0)

    warp.handleToggleAll(true)
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)

    expect(warp.selectedThemeIds.has('warp:one')).toBe(true)
    expect(warp.selectedThemeIds.has('warp:two')).toBe(true)
  })

  it('reports desktop-only preview responses', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: false,
      desktopOnly: true,
      themes: [],
      skippedFiles: [],
      error: 'Warp theme import is available in the desktop app.'
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)

    expect(warp.desktopOnly).toBe(true)
  })

  it('keeps an empty errorless preview unselected and not found', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: false,
      sourceLabel: 'Warp themes',
      skippedFiles: [],
      themes: []
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)

    expect(warp.selectedThemeIds.size).toBe(0)
    expect(warp.preview?.found).toBe(false)
    expect(warp.preview?.error).toBeUndefined()
  })

  it('opens the modal in yaml mode once the picker returns a selection', async () => {
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      sourceLabel: 'My Custom Theme.yaml',
      skippedFiles: [],
      themes: [
        {
          id: 'warp:my-custom-theme',
          selectionValue: 'custom:warp:my-custom-theme',
          name: 'My Custom Theme',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#10141c', foreground: '#d8dee9', black: '#1c2230' },
          importedAt: '2026-06-09T00:00:00.000Z',
          sourceLabel: 'My Custom Theme.yaml'
        }
      ]
    }
    const previewMock = vi.fn().mockResolvedValue(previewResponse)
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleImportYamlClick()
    expect(previewMock).toHaveBeenCalledWith({ kind: 'chooseFile' })

    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.open).toBe(true)
    expect(warp.mode).toBe('yaml')
    expect(warp.selectedThemeIds.has('warp:my-custom-theme')).toBe(true)
  })

  it('keeps the modal closed when the yaml picker is canceled', async () => {
    const previewMock = vi
      .fn()
      .mockResolvedValue({ found: false, canceled: true, themes: [], skippedFiles: [] })
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleImportYamlClick()

    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.open).toBe(false)
    expect(warp.preview).toBeNull()
  })

  it('keeps the current preview when an in-modal picker is canceled', async () => {
    const autoResponse: WarpThemeImportPreview = {
      found: true,
      sourceLabel: 'Warp themes',
      skippedFiles: [],
      themes: [
        {
          id: 'warp:tokyo-night',
          selectionValue: 'custom:warp:tokyo-night',
          name: 'Tokyo Night',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#1a1b26', foreground: '#c0caf5', black: '#15161e' },
          importedAt: '2026-06-05T00:00:00.000Z',
          sourceLabel: 'Warp themes'
        }
      ]
    }
    const previewMock = vi
      .fn()
      .mockResolvedValueOnce(autoResponse)
      .mockResolvedValueOnce({ found: false, canceled: true, themes: [], skippedFiles: [] })
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: previewMock } }
    })

    let warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    await warp.handlePreviewSource({ kind: 'chooseFile' })

    resetMockState()
    warp = useWarpThemeImport(vi.fn(), baseSettings)
    expect(warp.preview?.found).toBe(true)
    expect(warp.selectedThemeIds.has('warp:tokyo-night')).toBe(true)
  })

  it('blocks applying new distinct themes that exceed the custom theme cap', async () => {
    const fullSettings = {
      ...baseSettings,
      terminalCustomThemes: Array.from({ length: MAX_TERMINAL_CUSTOM_THEMES }, (_, index) => ({
        id: `warp:existing-${index}`,
        name: `Existing ${index}`,
        source: 'warp' as const,
        mode: 'dark' as const,
        terminal: { background: '#000000', foreground: '#ffffff', black: '#111111' },
        importedAt: '2026-06-01T00:00:00.000Z'
      }))
    } as GlobalSettings
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      skippedFiles: [],
      themes: [
        {
          id: 'warp:new-theme:new-theme-yaml',
          selectionValue: 'custom:warp:new-theme:new-theme-yaml',
          name: 'New Theme',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#000000', foreground: '#ffffff', black: '#222222' },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ]
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })
    const updateSettings = vi.fn()

    let warp = useWarpThemeImport(updateSettings, fullSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(updateSettings, fullSettings)
    await warp.handleApply()
    resetMockState()
    warp = useWarpThemeImport(updateSettings, fullSettings)

    expect(updateSettings).not.toHaveBeenCalled()
    expect(warp.applyError).toContain('custom terminal theme limit')
  })

  it('allows replacements when the custom theme list is already at the cap', async () => {
    const fullSettings = {
      ...baseSettings,
      terminalCustomThemes: Array.from({ length: MAX_TERMINAL_CUSTOM_THEMES }, (_, index) => ({
        id: index === 0 ? 'warp:replacement' : `warp:existing-${index}`,
        name: `Existing ${index}`,
        source: 'warp' as const,
        mode: 'dark' as const,
        terminal: { background: '#000000', foreground: '#ffffff', black: '#111111' },
        importedAt: '2026-06-01T00:00:00.000Z'
      }))
    } as GlobalSettings
    const previewResponse: WarpThemeImportPreview = {
      found: true,
      skippedFiles: [],
      themes: [
        {
          id: 'warp:replacement',
          selectionValue: 'custom:warp:replacement',
          name: 'Replacement',
          source: 'warp',
          mode: 'dark',
          terminal: { background: '#000000', foreground: '#ffffff', black: '#222222' },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ]
    }
    vi.stubGlobal('window', {
      api: { settings: { previewWarpThemeImport: vi.fn().mockResolvedValue(previewResponse) } }
    })
    const updateSettings = vi.fn()

    let warp = useWarpThemeImport(updateSettings, fullSettings)
    await warp.handleClick()
    resetMockState()
    warp = useWarpThemeImport(updateSettings, fullSettings)
    await warp.handleApply()

    expect(updateSettings).toHaveBeenCalledWith({
      terminalCustomThemes: expect.arrayContaining([
        expect.objectContaining({ id: 'warp:replacement', name: 'Replacement' })
      ])
    })
  })
})
