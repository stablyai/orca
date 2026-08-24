import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GhosttyImportPreview, GlobalSettings } from '../../../../shared/global-settings-types'

const mockStateValues: unknown[] = []
let mockStateIndex = 0
const mockRefValues: { current: unknown }[] = []
let mockRefIndex = 0

const baseSettings: GlobalSettings = {
  theme: 'system',
  terminalFontFamily: 'Menlo',
  terminalFontSize: 12,
  terminalFontWeight: 400,
  terminalLineHeight: 1,
  terminalGpuAcceleration: 'auto',
  terminalCursorStyle: 'bar',
  terminalCursorBlink: true,
  terminalScrollbackRows: 5_000,
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
  mockRefIndex = 0
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      void effect()
    },
    useRef: (initial: unknown) => {
      const i = mockRefIndex++
      mockRefValues[i] ??= { current: initial }
      return mockRefValues[i]
    },
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
    mockRefValues.length = 0
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

  it('keeps the newest preview when responses resolve out of order', async () => {
    const first = createDeferred<GhosttyImportPreview>()
    const second = createDeferred<GhosttyImportPreview>()
    const firstResponse = {
      found: true,
      diff: { terminalFontSize: 13 },
      unsupportedKeys: []
    } satisfies GhosttyImportPreview
    const secondResponse = {
      found: true,
      diff: { terminalFontSize: 15 },
      unsupportedKeys: []
    } satisfies GhosttyImportPreview
    const previewMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    let ghostty = useGhosttyImport(vi.fn(), baseSettings)
    const firstRequest = ghostty.handleClick()
    const secondRequest = ghostty.handleClick()

    second.resolve(secondResponse)
    await secondRequest
    first.resolve(firstResponse)
    await firstRequest

    resetMockState()
    ghostty = useGhosttyImport(vi.fn(), baseSettings)
    expect(ghostty.preview).toEqual(secondResponse)
    expect(ghostty.loading).toBe(false)
  })

  it('ignores a closed preview after reopening with a new request', async () => {
    const first = createDeferred<GhosttyImportPreview>()
    const second = createDeferred<GhosttyImportPreview>()
    const previewMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    vi.stubGlobal('window', {
      api: { settings: { previewGhosttyImport: previewMock } }
    })

    let ghostty = useGhosttyImport(vi.fn(), baseSettings)
    const firstRequest = ghostty.handleClick()
    ghostty.handleOpenChange(false)
    resetMockState()
    ghostty = useGhosttyImport(vi.fn(), baseSettings)
    const secondRequest = ghostty.handleClick()

    first.resolve({ found: false, diff: {}, unsupportedKeys: [], error: 'stale' })
    await firstRequest
    resetMockState()
    ghostty = useGhosttyImport(vi.fn(), baseSettings)
    expect(ghostty.open).toBe(true)
    expect(ghostty.preview).toBeNull()
    expect(ghostty.loading).toBe(true)

    const currentResponse = {
      found: true,
      diff: { terminalFontSize: 16 },
      unsupportedKeys: []
    } satisfies GhosttyImportPreview
    second.resolve(currentResponse)
    await secondRequest
    resetMockState()
    ghostty = useGhosttyImport(vi.fn(), baseSettings)
    expect(ghostty.preview).toEqual(currentResponse)
    expect(ghostty.loading).toBe(false)
  })
})
