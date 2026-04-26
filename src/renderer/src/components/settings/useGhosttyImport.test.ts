import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhosttyImportPreview, GlobalSettings } from '../../../../shared/types'

const mockStateValues: unknown[] = []
let mockStateIndex = 0

const baseSettings: GlobalSettings = {
  theme: 'system',
  terminalFontFamily: 'Menlo',
  terminalFontSize: 12,
  terminalFontWeight: 400,
  terminalLineHeight: 1,
  terminalCursorStyle: 'bar',
  terminalCursorBlink: true,
  terminalScrollbackBytes: 10_000_000,
  terminalBackgroundOpacity: 1,
  terminalInactivePaneOpacity: 1,
  terminalPaddingX: 0,
  terminalPaddingY: 0,
  terminalDividerColorDark: '#333333',
  terminalDividerColorLight: '#cccccc',
  terminalColorOverrides: {}
} as GlobalSettings

function resetMockState() {
  mockStateIndex = 0
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = mockStateIndex++
      if (mockStateValues[i] === undefined) {
        mockStateValues[i] = initial
      }
      const setter = (v: unknown) => {
        mockStateValues[i] = v
      }
      return [mockStateValues[i], setter]
    }
  }
})

import { useGhosttyImport } from './useGhosttyImport'

describe('useGhosttyImport', () => {
  beforeEach(() => {
    mockStateValues.length = 0
    resetMockState()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('does not call previewGhosttyImport on mount (no background execution)', () => {
    const previewMock = vi.fn()
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()
    useGhosttyImport(updateSettings, baseSettings)

    expect(previewMock).not.toHaveBeenCalled()
  })

  it('flows through click -> preview -> apply -> success -> close/reset', async () => {
    const previewResponse: GhosttyImportPreview = {
      found: true,
      configPath: '/Users/alice/.config/ghostty/config',
      diff: { terminalFontSize: 14, terminalFontFamily: 'JetBrains Mono' },
      unsupportedKeys: ['background']
    }
    const previewMock = vi.fn().mockResolvedValue(previewResponse)
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()

    // Initial render
    let ghostty = useGhosttyImport(updateSettings, baseSettings)
    expect(ghostty.open).toBe(false)
    expect(ghostty.loading).toBe(false)
    expect(ghostty.preview).toBeNull()
    expect(ghostty.applied).toBe(false)
    expect(previewMock).not.toHaveBeenCalled()

    // User clicks "Import from Ghostty"
    resetMockState()
    await ghostty.handleClick()

    // After async preview resolves, re-render to get fresh closures
    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    expect(ghostty.open).toBe(true)
    expect(ghostty.loading).toBe(false)
    expect(ghostty.preview).toEqual(previewResponse)
    expect(ghostty.applied).toBe(false)
    expect(previewMock).toHaveBeenCalledTimes(1)

    // User applies the previewed changes
    await ghostty.handleApply()
    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith(previewResponse.diff)

    // After apply, re-render
    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    expect(ghostty.applied).toBe(true)

    // User closes the modal
    ghostty.handleOpenChange(false)

    // After close, re-render — state is fully reset
    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    expect(ghostty.open).toBe(false)
    expect(ghostty.preview).toBeNull()
    expect(ghostty.applied).toBe(false)
    expect(ghostty.loading).toBe(false)
  })

  it('does not call updateSettings when diff is empty', async () => {
    const previewResponse: GhosttyImportPreview = {
      found: true,
      configPath: '/path',
      diff: {},
      unsupportedKeys: []
    }
    const previewMock = vi.fn().mockResolvedValue(previewResponse)
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()

    let ghostty = useGhosttyImport(updateSettings, baseSettings)
    resetMockState()
    await ghostty.handleClick()

    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    await ghostty.handleApply()

    expect(updateSettings).not.toHaveBeenCalled()
    expect(ghostty.applied).toBe(false)
  })

  it('handles preview errors gracefully', async () => {
    const previewMock = vi.fn().mockRejectedValue(new Error('disk error'))
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()

    let ghostty = useGhosttyImport(updateSettings, baseSettings)
    resetMockState()
    await ghostty.handleClick()

    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    expect(ghostty.preview).toEqual({
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: 'disk error'
    })
    expect(ghostty.loading).toBe(false)
    expect(ghostty.open).toBe(true)
  })

  it('does not apply when preview is not found', async () => {
    const previewMock = vi.fn().mockResolvedValue({
      found: false,
      diff: {},
      unsupportedKeys: []
    })
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()

    let ghostty = useGhosttyImport(updateSettings, baseSettings)
    resetMockState()
    await ghostty.handleClick()

    resetMockState()
    ghostty = useGhosttyImport(updateSettings, baseSettings)
    await ghostty.handleApply()

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('merges terminalColorOverrides with existing settings on apply', async () => {
    const existingSettings: GlobalSettings = {
      ...baseSettings,
      terminalColorOverrides: { foreground: '#e0e0e0', red: '#ff0000' }
    } as GlobalSettings
    const previewResponse: GhosttyImportPreview = {
      found: true,
      configPath: '/path',
      diff: { terminalColorOverrides: { background: '#1a1a1a' } },
      unsupportedKeys: []
    }
    const previewMock = vi.fn().mockResolvedValue(previewResponse)
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    const updateSettings = vi.fn()

    let ghostty = useGhosttyImport(updateSettings, existingSettings)
    resetMockState()
    await ghostty.handleClick()

    resetMockState()
    ghostty = useGhosttyImport(updateSettings, existingSettings)
    await ghostty.handleApply()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({
      terminalColorOverrides: {
        foreground: '#e0e0e0',
        red: '#ff0000',
        background: '#1a1a1a'
      }
    })
  })
})
